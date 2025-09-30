const { TextractClient, DetectDocumentTextCommand, AnalyzeDocumentCommand } = require('@aws-sdk/client-textract');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'textract-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Initialize Textract client
const textractClient = new TextractClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

class TextractService {
  /**
   * Extracts text from image using AWS Textract
   * @param {Buffer} imageBuffer - Image buffer
   * @param {string} fileName - Original filename
   * @returns {Promise<Object>} - Extracted text and metadata
   */
  async extractTextFromImage(imageBuffer, fileName) {
    try {
      logger.info('Extracting text from image using Textract', { fileName, size: imageBuffer.length });

      // Check image size (Textract has limits)
      const maxSize = 10 * 1024 * 1024; // 10MB for synchronous processing
      if (imageBuffer.length > maxSize) {
        throw new Error(`Image size (${Math.round(imageBuffer.length / 1024 / 1024)}MB) exceeds Textract limit (10MB)`);
      }

      const command = new DetectDocumentTextCommand({
        Document: {
          Bytes: imageBuffer
        }
      });

      const response = await textractClient.send(command);

      // Process response to extract text and structure
      const result = this.processTextractResponse(response, fileName);

      logger.info('Text extraction completed', { 
        fileName, 
        blocksFound: response.Blocks?.length || 0,
        textLength: result.fullText.length
      });

      return result;
    } catch (error) {
      logger.error('Error extracting text from image', { fileName, error: error.message });
      throw new Error(`Failed to extract text from image: ${error.message}`);
    }
  }

  /**
   * Analyzes document structure using AWS Textract
   * @param {Buffer} imageBuffer - Image buffer
   * @param {string} fileName - Original filename
   * @returns {Promise<Object>} - Structured analysis results
   */
  async analyzeDocument(imageBuffer, fileName) {
    try {
      logger.info('Analyzing document structure using Textract', { fileName });

      const command = new AnalyzeDocumentCommand({
        Document: {
          Bytes: imageBuffer
        },
        FeatureTypes: ['TABLES', 'FORMS']
      });

      const response = await textractClient.send(command);
      const result = this.processAnalyzeResponse(response, fileName);

      logger.info('Document analysis completed', { 
        fileName,
        tablesFound: result.tables.length,
        formsFound: result.forms.length
      });

      return result;
    } catch (error) {
      logger.error('Error analyzing document', { fileName, error: error.message });
      // Fall back to simple text extraction
      return await this.extractTextFromImage(imageBuffer, fileName);
    }
  }

  /**
   * Processes Textract DetectDocumentText response
   * @param {Object} response - Textract response
   * @param {string} fileName - Original filename
   * @returns {Object} - Processed results
   */
  processTextractResponse(response, fileName) {
    const blocks = response.Blocks || [];
    const lines = [];
    const words = [];
    let fullText = '';

    blocks.forEach(block => {
      switch (block.BlockType) {
        case 'LINE':
          lines.push({
            text: block.Text,
            confidence: block.Confidence,
            boundingBox: block.Geometry?.BoundingBox
          });
          fullText += block.Text + '\n';
          break;
        case 'WORD':
          words.push({
            text: block.Text,
            confidence: block.Confidence,
            boundingBox: block.Geometry?.BoundingBox
          });
          break;
      }
    });

    return {
      fileName,
      fullText: fullText.trim(),
      lines,
      words,
      totalBlocks: blocks.length,
      averageConfidence: this.calculateAverageConfidence(blocks),
      extractedAt: new Date().toISOString()
    };
  }

  /**
   * Processes Textract AnalyzeDocument response
   * @param {Object} response - Textract response
   * @param {string} fileName - Original filename
   * @returns {Object} - Processed structured results
   */
  processAnalyzeResponse(response, fileName) {
    const blocks = response.Blocks || [];
    const tables = [];
    const forms = [];
    let fullText = '';

    // Create lookup maps
    const blockMap = {};
    blocks.forEach(block => {
      blockMap[block.Id] = block;
    });

    blocks.forEach(block => {
      switch (block.BlockType) {
        case 'LINE':
          fullText += block.Text + '\n';
          break;
        case 'TABLE':
          tables.push(this.processTable(block, blockMap));
          break;
        case 'KEY_VALUE_SET':
          if (block.EntityTypes?.includes('KEY')) {
            const form = this.processForm(block, blockMap);
            if (form) forms.push(form);
          }
          break;
      }
    });

    return {
      fileName,
      fullText: fullText.trim(),
      tables,
      forms,
      totalBlocks: blocks.length,
      averageConfidence: this.calculateAverageConfidence(blocks),
      extractedAt: new Date().toISOString()
    };
  }

  /**
   * Processes a table block
   * @param {Object} tableBlock - Table block from Textract
   * @param {Object} blockMap - Map of all blocks
   * @returns {Object} - Processed table
   */
  processTable(tableBlock, blockMap) {
    const table = {
      confidence: tableBlock.Confidence,
      rows: []
    };

    const relationships = tableBlock.Relationships || [];
    const childIds = relationships
      .filter(rel => rel.Type === 'CHILD')
      .flatMap(rel => rel.Ids || []);

    const cells = childIds.map(id => blockMap[id]).filter(block => block?.BlockType === 'CELL');
    
    // Group cells by row
    const rowMap = {};
    cells.forEach(cell => {
      const rowIndex = cell.RowIndex || 0;
      const colIndex = cell.ColumnIndex || 0;
      
      if (!rowMap[rowIndex]) rowMap[rowIndex] = {};
      rowMap[rowIndex][colIndex] = {
        text: this.getCellText(cell, blockMap),
        confidence: cell.Confidence
      };
    });

    // Convert to array format
    Object.keys(rowMap).sort((a, b) => parseInt(a) - parseInt(b)).forEach(rowIndex => {
      const row = [];
      const rowData = rowMap[rowIndex];
      Object.keys(rowData).sort((a, b) => parseInt(a) - parseInt(b)).forEach(colIndex => {
        row.push(rowData[colIndex]);
      });
      table.rows.push(row);
    });

    return table;
  }

  /**
   * Processes a form field
   * @param {Object} keyBlock - Key block from Textract
   * @param {Object} blockMap - Map of all blocks
   * @returns {Object} - Processed form field
   */
  processForm(keyBlock, blockMap) {
    const keyText = this.getCellText(keyBlock, blockMap);
    
    // Find corresponding value
    const relationships = keyBlock.Relationships || [];
    const valueRelation = relationships.find(rel => rel.Type === 'VALUE');
    
    if (!valueRelation || !valueRelation.Ids) return null;

    const valueBlock = blockMap[valueRelation.Ids[0]];
    const valueText = valueBlock ? this.getCellText(valueBlock, blockMap) : '';

    return {
      key: keyText,
      value: valueText,
      keyConfidence: keyBlock.Confidence,
      valueConfidence: valueBlock?.Confidence || 0
    };
  }

  /**
   * Extracts text from a cell or block
   * @param {Object} block - Block to extract text from
   * @param {Object} blockMap - Map of all blocks
   * @returns {string} - Extracted text
   */
  getCellText(block, blockMap) {
    const relationships = block.Relationships || [];
    const childRelation = relationships.find(rel => rel.Type === 'CHILD');
    
    if (!childRelation || !childRelation.Ids) return '';

    return childRelation.Ids
      .map(id => blockMap[id])
      .filter(childBlock => childBlock?.BlockType === 'WORD')
      .map(wordBlock => wordBlock.Text)
      .join(' ');
  }

  /**
   * Calculates average confidence score
   * @param {Array} blocks - Array of blocks
   * @returns {number} - Average confidence
   */
  calculateAverageConfidence(blocks) {
    const confidenceBlocks = blocks.filter(block => block.Confidence !== undefined);
    if (confidenceBlocks.length === 0) return 0;

    const sum = confidenceBlocks.reduce((acc, block) => acc + block.Confidence, 0);
    return sum / confidenceBlocks.length;
  }

  /**
   * Checks if image is suitable for OCR
   * @param {Buffer} imageBuffer - Image buffer
   * @param {string} mimeType - Image MIME type
   * @returns {Object} - Suitability assessment
   */
  assessImageSuitability(imageBuffer, mimeType) {
    const assessment = {
      suitable: true,
      warnings: [],
      recommendations: []
    };

    // Check file size
    const sizeInMB = imageBuffer.length / (1024 * 1024);
    if (sizeInMB > 10) {
      assessment.suitable = false;
      assessment.warnings.push(`Image size (${sizeInMB.toFixed(1)}MB) exceeds Textract limit (10MB)`);
    } else if (sizeInMB > 5) {
      assessment.warnings.push('Large image size may increase processing time');
    }

    // Check MIME type
    const supportedTypes = ['image/jpeg', 'image/png'];
    if (!supportedTypes.includes(mimeType)) {
      assessment.suitable = false;
      assessment.warnings.push(`Image type ${mimeType} not supported by Textract. Supported: JPEG, PNG`);
    }

    // Add recommendations
    if (assessment.suitable) {
      assessment.recommendations.push('Ensure image has good contrast and resolution for best OCR results');
      assessment.recommendations.push('Text should be horizontal and clearly visible');
    }

    return assessment;
  }
}

module.exports = new TextractService();
