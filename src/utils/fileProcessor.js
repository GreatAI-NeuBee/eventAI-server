const winston = require('winston');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const textractService = require('../services/textractService');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'file-processor' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

class FileProcessor {
  /**
   * Extracts text content from various file types
   * @param {Buffer} fileBuffer - File buffer
   * @param {string} mimeType - File MIME type
   * @param {string} originalName - Original filename
   * @returns {Promise<string>} - Extracted text content
   */
  async extractTextContent(fileBuffer, mimeType, originalName) {
    try {
      logger.info('Extracting text content', { mimeType, originalName });

      let textContent = '';

      switch (mimeType) {
        case 'text/plain':
        case 'text/markdown':
          textContent = fileBuffer.toString('utf-8');
          break;

        case 'text/csv':
          textContent = await this.extractCsvContent(fileBuffer, originalName);
          break;

        case 'application/json':
          try {
            const jsonData = JSON.parse(fileBuffer.toString('utf-8'));
            textContent = JSON.stringify(jsonData, null, 2);
          } catch (error) {
            logger.warn('Failed to parse JSON, treating as plain text', { originalName });
            textContent = fileBuffer.toString('utf-8');
          }
          break;

        case 'text/html':
          // Basic HTML tag removal - for production, consider using a proper HTML parser
          textContent = fileBuffer.toString('utf-8')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          break;

        case 'application/pdf':
          textContent = await this.extractPdfContent(fileBuffer, originalName);
          break;

        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          textContent = await this.extractDocxContent(fileBuffer, originalName);
          break;

        case 'application/msword':
          textContent = `[WORD DOCUMENT: ${originalName}] - Legacy .doc format not fully supported. Please convert to .docx format for better text extraction.`;
          logger.warn('Legacy Word document detected', { originalName });
          break;

        case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        case 'application/vnd.ms-excel':
          textContent = await this.extractExcelContent(fileBuffer, originalName);
          break;

        case 'image/jpeg':
        case 'image/png':
          textContent = await this.extractImageContent(fileBuffer, originalName, mimeType);
          break;

        case 'image/gif':
        case 'image/bmp':
        case 'image/webp':
          textContent = `[IMAGE FILE: ${originalName}] - Image type ${mimeType} not supported by AWS Textract. Please convert to JPEG or PNG format for OCR.`;
          logger.warn('Unsupported image format for OCR', { originalName, mimeType });
          break;

        default:
          // Try to read as text for unknown types
          try {
            const potentialText = fileBuffer.toString('utf-8');
            // Check if it looks like text (contains mostly printable characters)
            if (this.isTextContent(potentialText)) {
              textContent = potentialText;
            } else {
              textContent = `[BINARY FILE: ${originalName}] - File type ${mimeType} is not supported for text extraction.`;
            }
          } catch (error) {
            textContent = `[UNSUPPORTED FILE: ${originalName}] - File type ${mimeType} is not supported for text extraction.`;
          }
          break;
      }

      logger.info('Text extraction completed', { 
        originalName, 
        mimeType, 
        extractedLength: textContent.length 
      });

      return textContent;
    } catch (error) {
      logger.error('Error extracting text content', { 
        originalName, 
        mimeType, 
        error: error.message 
      });
      return `[ERROR PROCESSING FILE: ${originalName}] - Failed to extract text content: ${error.message}`;
    }
  }

  /**
   * Extracts and formats content from CSV files
   * @param {Buffer} fileBuffer - CSV file buffer
   * @param {string} originalName - Original filename
   * @returns {Promise<string>} - Formatted CSV content with metadata
   */
  async extractCsvContent(fileBuffer, originalName) {
    try {
      logger.info('Extracting and formatting CSV content', { originalName });
      
      const csvText = fileBuffer.toString('utf-8');
      const lines = csvText.split('\n').filter(line => line.trim());
      
      if (lines.length === 0) {
        return `[EMPTY CSV FILE: ${originalName}] - No content found`;
      }

      // Parse CSV structure
      const delimiter = this.detectCsvDelimiter(csvText);
      const headers = lines[0].split(delimiter).map(h => h.trim().replace(/"/g, ''));
      const dataRows = lines.slice(1).map(line => 
        line.split(delimiter).map(cell => cell.trim().replace(/"/g, ''))
      );

      // Create structured analysis
      let formattedContent = `[CSV FILE: ${originalName}]\n`;
      formattedContent += `Rows: ${dataRows.length + 1} (including header)\n`;
      formattedContent += `Columns: ${headers.length}\n`;
      formattedContent += `Column Headers: ${headers.join(', ')}\n`;
      formattedContent += `Delimiter: "${delimiter}"\n\n`;

      // Add data summary
      formattedContent += `=== DATA SUMMARY ===\n`;
      headers.forEach((header, index) => {
        const columnData = dataRows.map(row => row[index] || '').filter(cell => cell);
        const uniqueValues = [...new Set(columnData)].slice(0, 5);
        formattedContent += `${header}: ${columnData.length} entries`;
        if (uniqueValues.length > 0) {
          formattedContent += ` (examples: ${uniqueValues.join(', ')})`;
        }
        formattedContent += '\n';
      });

      formattedContent += `\n=== STRUCTURED DATA ===\n`;
      
      // Format data in a readable way for AI
      dataRows.forEach((row, index) => {
        formattedContent += `\nRecord ${index + 1}:\n`;
        headers.forEach((header, colIndex) => {
          const value = row[colIndex] || '';
          if (value) {
            formattedContent += `  ${header}: ${value}\n`;
          }
        });
      });

      // Add pattern analysis
      formattedContent += `\n=== CONTENT ANALYSIS ===\n`;
      
      // Detect time/schedule patterns
      const timePattern = /\b\d{1,2}:\d{2}\b/g;
      const timeMatches = csvText.match(timePattern) || [];
      if (timeMatches.length > 0) {
        formattedContent += `Time entries found: ${[...new Set(timeMatches)].join(', ')}\n`;
      }

      // Detect date patterns
      const datePattern = /\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b|\b[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}\b/g;
      const dateMatches = csvText.match(datePattern) || [];
      if (dateMatches.length > 0) {
        formattedContent += `Date entries found: ${[...new Set(dateMatches)].join(', ')}\n`;
      }

      // Detect location patterns
      const locationKeywords = ['room', 'hall', 'stage', 'area', 'venue', 'building', 'floor'];
      const locationMatches = [];
      locationKeywords.forEach(keyword => {
        const regex = new RegExp(`\\b[^,\n]*${keyword}[^,\n]*\\b`, 'gi');
        const matches = csvText.match(regex) || [];
        locationMatches.push(...matches);
      });
      if (locationMatches.length > 0) {
        formattedContent += `Location references: ${[...new Set(locationMatches)].slice(0, 5).join(', ')}\n`;
      }

      // Detect people/roles
      const roleKeywords = ['manager', 'team', 'host', 'speaker', 'coordinator', 'staff', 'volunteer'];
      const roleMatches = [];
      roleKeywords.forEach(keyword => {
        const regex = new RegExp(`\\b[^,\n]*${keyword}[^,\n]*\\b`, 'gi');
        const matches = csvText.match(regex) || [];
        roleMatches.push(...matches);
      });
      if (roleMatches.length > 0) {
        formattedContent += `Roles/People mentioned: ${[...new Set(roleMatches)].slice(0, 5).join(', ')}\n`;
      }

      // Add original CSV for reference
      formattedContent += `\n=== ORIGINAL CSV DATA ===\n${csvText}`;

      logger.info('CSV content extraction completed', { 
        originalName,
        rows: dataRows.length + 1,
        columns: headers.length,
        contentLength: formattedContent.length
      });

      return formattedContent;
    } catch (error) {
      logger.error('Error extracting CSV content', { originalName, error: error.message });
      return `[CSV EXTRACTION ERROR: ${originalName}] - Failed to extract CSV content: ${error.message}`;
    }
  }

  /**
   * Detects the delimiter used in a CSV file
   * @param {string} csvText - CSV text content
   * @returns {string} - Detected delimiter
   */
  detectCsvDelimiter(csvText) {
    const delimiters = [',', ';', '\t', '|'];
    const firstLine = csvText.split('\n')[0];
    
    let maxCount = 0;
    let detectedDelimiter = ',';
    
    delimiters.forEach(delimiter => {
      const count = (firstLine.match(new RegExp(`\\${delimiter}`, 'g')) || []).length;
      if (count > maxCount) {
        maxCount = count;
        detectedDelimiter = delimiter;
      }
    });
    
    return detectedDelimiter;
  }

  /**
   * Extracts text content from PDF files
   * @param {Buffer} fileBuffer - PDF file buffer
   * @param {string} originalName - Original filename
   * @returns {Promise<string>} - Extracted text content
   */
  async extractPdfContent(fileBuffer, originalName) {
    try {
      logger.info('Extracting text from PDF', { originalName });
      
      const data = await pdfParse(fileBuffer, {
        // Options for better text extraction
        max: 0, // Extract all pages
        version: 'v1.10.100'
      });

      const extractedText = data.text || '';
      const metadata = {
        pages: data.numpages || 0,
        info: data.info || {},
        version: data.version || 'unknown'
      };

      logger.info('PDF text extraction completed', { 
        originalName, 
        pages: metadata.pages,
        textLength: extractedText.length 
      });

      // Add metadata as header
      const metadataHeader = `[PDF DOCUMENT: ${originalName}]\n` +
        `Pages: ${metadata.pages}\n` +
        `Title: ${metadata.info.Title || 'Not specified'}\n` +
        `Author: ${metadata.info.Author || 'Not specified'}\n` +
        `Subject: ${metadata.info.Subject || 'Not specified'}\n` +
        `Creator: ${metadata.info.Creator || 'Not specified'}\n` +
        `Producer: ${metadata.info.Producer || 'Not specified'}\n` +
        `Creation Date: ${metadata.info.CreationDate || 'Not specified'}\n` +
        `Modification Date: ${metadata.info.ModDate || 'Not specified'}\n\n` +
        `--- EXTRACTED CONTENT ---\n\n`;

      return metadataHeader + extractedText;
    } catch (error) {
      logger.error('Error extracting PDF content', { originalName, error: error.message });
      return `[PDF EXTRACTION ERROR: ${originalName}] - Failed to extract text from PDF: ${error.message}`;
    }
  }

  /**
   * Extracts text content from Word documents (.docx)
   * @param {Buffer} fileBuffer - Word document buffer
   * @param {string} originalName - Original filename
   * @returns {Promise<string>} - Extracted text content
   */
  async extractDocxContent(fileBuffer, originalName) {
    try {
      logger.info('Extracting text from Word document', { originalName });
      
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      const extractedText = result.value || '';
      const messages = result.messages || [];

      logger.info('Word document text extraction completed', { 
        originalName,
        textLength: extractedText.length,
        warnings: messages.length
      });

      // Log any extraction warnings
      if (messages.length > 0) {
        logger.warn('Word document extraction warnings', { 
          originalName, 
          warnings: messages.map(m => m.message) 
        });
      }

      // Add metadata header
      const metadataHeader = `[WORD DOCUMENT: ${originalName}]\n` +
        `Text Length: ${extractedText.length} characters\n` +
        `Extraction Warnings: ${messages.length}\n\n` +
        `--- EXTRACTED CONTENT ---\n\n`;

      return metadataHeader + extractedText;
    } catch (error) {
      logger.error('Error extracting Word document content', { originalName, error: error.message });
      return `[WORD EXTRACTION ERROR: ${originalName}] - Failed to extract text from Word document: ${error.message}`;
    }
  }

  /**
   * Extracts data from Excel files
   * @param {Buffer} fileBuffer - Excel file buffer
   * @param {string} originalName - Original filename
   * @returns {Promise<string>} - Extracted and formatted content
   */
  async extractExcelContent(fileBuffer, originalName) {
    try {
      logger.info('Extracting data from Excel file', { originalName });
      
      const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
      const sheetNames = workbook.SheetNames;
      let extractedContent = '';

      // Process each worksheet
      sheetNames.forEach((sheetName, index) => {
        const worksheet = workbook.Sheets[sheetName];
        
        // Convert to JSON for structured data
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
          header: 1, // Use array of arrays format
          defval: '' // Default value for empty cells
        });

        // Convert to CSV-like text format
        const csvText = jsonData
          .map(row => row.join('\t')) // Use tabs for better formatting
          .join('\n');

        // Get sheet range info
        const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:A1');
        const rowCount = range.e.r + 1;
        const colCount = range.e.c + 1;

        extractedContent += `\n--- WORKSHEET ${index + 1}: ${sheetName} ---\n`;
        extractedContent += `Dimensions: ${rowCount} rows x ${colCount} columns\n`;
        extractedContent += `Range: ${worksheet['!ref'] || 'Empty'}\n\n`;
        extractedContent += csvText + '\n';
      });

      logger.info('Excel data extraction completed', { 
        originalName,
        sheets: sheetNames.length,
        contentLength: extractedContent.length
      });

      // Add metadata header
      const metadataHeader = `[EXCEL SPREADSHEET: ${originalName}]\n` +
        `Worksheets: ${sheetNames.length}\n` +
        `Sheet Names: ${sheetNames.join(', ')}\n` +
        `Total Content Length: ${extractedContent.length} characters\n\n` +
        `--- EXTRACTED DATA ---`;

      return metadataHeader + extractedContent;
    } catch (error) {
      logger.error('Error extracting Excel content', { originalName, error: error.message });
      return `[EXCEL EXTRACTION ERROR: ${originalName}] - Failed to extract data from Excel file: ${error.message}`;
    }
  }

  /**
   * Extracts text from images using AWS Textract OCR
   * @param {Buffer} fileBuffer - Image file buffer
   * @param {string} originalName - Original filename
   * @param {string} mimeType - Image MIME type
   * @returns {Promise<string>} - Extracted text content
   */
  async extractImageContent(fileBuffer, originalName, mimeType) {
    try {
      logger.info('Extracting text from image using OCR', { originalName, mimeType });

      // Check if image is suitable for OCR
      const suitability = textractService.assessImageSuitability(fileBuffer, mimeType);
      if (!suitability.suitable) {
        return `[IMAGE OCR ERROR: ${originalName}] - ${suitability.warnings.join('; ')}`;
      }

      // Try advanced document analysis first (for structured documents)
      let ocrResult;
      try {
        ocrResult = await textractService.analyzeDocument(fileBuffer, originalName);
      } catch (analysisError) {
        logger.warn('Document analysis failed, falling back to text extraction', { 
          originalName, 
          error: analysisError.message 
        });
        // Fall back to simple text extraction
        ocrResult = await textractService.extractTextFromImage(fileBuffer, originalName);
      }

      // Format the extracted content
      let formattedContent = '';

      // Add metadata header
      formattedContent += `[IMAGE FILE: ${originalName}]\n`;
      formattedContent += `MIME Type: ${mimeType}\n`;
      formattedContent += `OCR Confidence: ${(ocrResult.averageConfidence || 0).toFixed(1)}%\n`;
      formattedContent += `Text Length: ${ocrResult.fullText.length} characters\n`;

      // Add structured data if available
      if (ocrResult.tables && ocrResult.tables.length > 0) {
        formattedContent += `Tables Found: ${ocrResult.tables.length}\n`;
      }
      if (ocrResult.forms && ocrResult.forms.length > 0) {
        formattedContent += `Form Fields Found: ${ocrResult.forms.length}\n`;
      }

      formattedContent += `\n--- EXTRACTED TEXT ---\n\n`;
      formattedContent += ocrResult.fullText;

      // Add structured data
      if (ocrResult.tables && ocrResult.tables.length > 0) {
        formattedContent += '\n\n--- TABLES ---\n';
        ocrResult.tables.forEach((table, index) => {
          formattedContent += `\nTable ${index + 1} (Confidence: ${(table.confidence || 0).toFixed(1)}%):\n`;
          table.rows.forEach((row, rowIndex) => {
            const rowText = row.map(cell => cell.text || '').join('\t');
            formattedContent += `Row ${rowIndex + 1}: ${rowText}\n`;
          });
        });
      }

      if (ocrResult.forms && ocrResult.forms.length > 0) {
        formattedContent += '\n\n--- FORM FIELDS ---\n';
        ocrResult.forms.forEach((field, index) => {
          formattedContent += `Field ${index + 1}: ${field.key} = ${field.value}\n`;
        });
      }

      logger.info('Image OCR completed successfully', { 
        originalName,
        confidence: ocrResult.averageConfidence,
        textLength: ocrResult.fullText.length,
        tablesFound: ocrResult.tables?.length || 0,
        formsFound: ocrResult.forms?.length || 0
      });

      return formattedContent;
    } catch (error) {
      logger.error('Error extracting text from image', { originalName, error: error.message });
      return `[IMAGE OCR ERROR: ${originalName}] - Failed to extract text from image: ${error.message}`;
    }
  }

  /**
   * Checks if content appears to be readable text
   * @param {string} content - Content to check
   * @returns {boolean} - True if content appears to be text
   */
  isTextContent(content) {
    if (!content || content.length === 0) return false;

    // Check first 1000 characters for text-like content
    const sample = content.substring(0, 1000);
    const printableChars = sample.replace(/[\x00-\x1F\x7F-\x9F]/g, '').length;
    const ratio = printableChars / sample.length;

    // If more than 80% of characters are printable, consider it text
    return ratio > 0.8;
  }

  /**
   * Validates file for processing
   * @param {Buffer} fileBuffer - File buffer
   * @param {string} mimeType - File MIME type
   * @param {string} originalName - Original filename
   * @returns {Object} - Validation result
   */
  validateFile(fileBuffer, mimeType, originalName) {
    const validation = {
      isValid: true,
      errors: [],
      warnings: []
    };

    // Check file size (max 50MB)
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (fileBuffer.length > maxSize) {
      validation.isValid = false;
      validation.errors.push(`File size (${Math.round(fileBuffer.length / 1024 / 1024)}MB) exceeds maximum allowed size (50MB)`);
    }

    // Check for empty files
    if (fileBuffer.length === 0) {
      validation.isValid = false;
      validation.errors.push('File is empty');
    }

    // Supported MIME types for full text extraction
    const fullySupported = [
      'text/plain',
      'text/csv',
      'text/markdown',
      'text/html',
      'application/json'
    ];

    // Partially supported (with warnings)
    const partiallySupported = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/bmp',
      'image/webp'
    ];

    if (!fullySupported.includes(mimeType)) {
      if (partiallySupported.includes(mimeType)) {
        validation.warnings.push(`File type ${mimeType} has limited text extraction support`);
      } else {
        validation.warnings.push(`File type ${mimeType} may not be supported for text extraction`);
      }
    }

    // Check filename extension matches MIME type
    const extension = originalName.toLowerCase().split('.').pop();
    const mimeExtensionMap = {
      'text/plain': ['txt', 'text'],
      'text/csv': ['csv'],
      'text/markdown': ['md', 'markdown'],
      'text/html': ['html', 'htm'],
      'application/json': ['json'],
      'application/pdf': ['pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
      'application/msword': ['doc'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
      'application/vnd.ms-excel': ['xls'],
      'image/jpeg': ['jpg', 'jpeg'],
      'image/png': ['png'],
      'image/gif': ['gif'],
      'image/bmp': ['bmp'],
      'image/webp': ['webp']
    };

    const expectedExtensions = mimeExtensionMap[mimeType];
    if (expectedExtensions && !expectedExtensions.includes(extension)) {
      validation.warnings.push(`File extension '${extension}' may not match MIME type '${mimeType}'`);
    }

    return validation;
  }

  /**
   * Gets supported file types information
   * @returns {Object} - Information about supported file types
   */
  getSupportedFileTypes() {
    return {
      fullySupported: {
        'text/plain': 'Plain text files (.txt) - Direct text extraction',
        'text/csv': 'Comma-separated values (.csv) - Direct text extraction',
        'text/markdown': 'Markdown files (.md) - Direct text extraction',
        'text/html': 'HTML files (.html, .htm) - HTML tag removal and text extraction',
        'application/json': 'JSON files (.json) - Structured data extraction',
        'application/pdf': 'PDF documents (.pdf) - Full text extraction with metadata',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word documents (.docx) - Full text extraction',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheets (.xlsx) - Data extraction from all worksheets',
        'application/vnd.ms-excel': 'Excel spreadsheets (.xls) - Data extraction from all worksheets',
        'image/jpeg': 'JPEG images (.jpg, .jpeg) - OCR text extraction with AWS Textract',
        'image/png': 'PNG images (.png) - OCR text extraction with AWS Textract'
      },
      partiallySupported: {
        'application/msword': 'Legacy Word documents (.doc) - Limited support, convert to .docx recommended',
        'image/gif': 'GIF images (.gif) - Not supported by AWS Textract, convert to JPEG/PNG',
        'image/bmp': 'BMP images (.bmp) - Not supported by AWS Textract, convert to JPEG/PNG',
        'image/webp': 'WebP images (.webp) - Not supported by AWS Textract, convert to JPEG/PNG'
      },
      maxFileSize: '50MB (10MB for images due to AWS Textract limits)',
      processingCapabilities: {
        pdf: {
          features: ['Full text extraction', 'Metadata extraction', 'Multi-page support'],
          metadata: ['Title', 'Author', 'Subject', 'Creator', 'Producer', 'Creation/Modification dates']
        },
        excel: {
          features: ['Multi-worksheet support', 'Structured data extraction', 'Cell formatting preservation'],
          formats: ['Tab-separated values', 'Worksheet metadata', 'Range information']
        },
        word: {
          features: ['Text extraction', 'Formatting removal', 'Warning detection'],
          limitations: ['Legacy .doc format has limited support']
        },
        images: {
          features: ['OCR text extraction', 'Table detection', 'Form field extraction', 'Confidence scoring'],
          services: ['AWS Textract for advanced document analysis'],
          limitations: ['JPEG and PNG only', '10MB size limit', 'Requires good image quality']
        }
      },
      recommendations: [
        'For best AI analysis results, ensure text is clearly readable and well-structured',
        'PDF and Word documents provide rich metadata for context',
        'Excel files are processed as structured data with worksheet separation',
        'Images should have high contrast and horizontal text for best OCR results',
        'Use JPEG or PNG format for images containing text',
        'Files larger than 10MB may take longer to process'
      ],
      aiOptimization: [
        'All extracted content includes metadata headers for better AI context',
        'Structured data (tables, forms) is preserved in readable format',
        'File type and extraction method information is included',
        'Error messages provide clear guidance for unsupported formats'
      ]
    };
  }
}

module.exports = new FileProcessor();
