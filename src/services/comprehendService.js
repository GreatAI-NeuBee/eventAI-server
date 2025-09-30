const { ComprehendClient, DetectSentimentCommand, DetectEntitiesCommand, DetectKeyPhrasesCommand, DetectDominantLanguageCommand } = require('@aws-sdk/client-comprehend');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'comprehend-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Initialize Comprehend client
const comprehendClient = new ComprehendClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

class ComprehendService {
  /**
   * Analyzes text content and extracts insights using AWS Comprehend
   * @param {string} text - Text content to analyze
   * @param {string} languageCode - Language code (default: 'en')
   * @returns {Promise<Object>} - Analysis results
   */
  async analyzeText(text, languageCode = 'en') {
    try {
      logger.info('Starting text analysis with Comprehend', { 
        textLength: text.length,
        languageCode 
      });

      // Truncate text if it's too long (Comprehend has limits)
      const maxLength = 5000; // AWS Comprehend limit for most operations
      const truncatedText = text.length > maxLength ? text.substring(0, maxLength) : text;

      if (text.length > maxLength) {
        logger.warn('Text truncated for Comprehend analysis', { 
          originalLength: text.length, 
          truncatedLength: maxLength 
        });
      }

      // Run all analyses in parallel for efficiency
      const [sentiment, entities, keyPhrases, language] = await Promise.allSettled([
        this.detectSentiment(truncatedText, languageCode),
        this.detectEntities(truncatedText, languageCode),
        this.detectKeyPhrases(truncatedText, languageCode),
        this.detectDominantLanguage(truncatedText)
      ]);

      // Compile results
      const analysis = {
        originalTextLength: text.length,
        analyzedTextLength: truncatedText.length,
        sentiment: sentiment.status === 'fulfilled' ? sentiment.value : null,
        entities: entities.status === 'fulfilled' ? entities.value : [],
        keyPhrases: keyPhrases.status === 'fulfilled' ? keyPhrases.value : [],
        detectedLanguage: language.status === 'fulfilled' ? language.value : null,
        summary: this.generateSummary(
          sentiment.status === 'fulfilled' ? sentiment.value : null,
          entities.status === 'fulfilled' ? entities.value : [],
          keyPhrases.status === 'fulfilled' ? keyPhrases.value : []
        ),
        analyzedAt: new Date().toISOString()
      };

      // Log any failed analyses
      [sentiment, entities, keyPhrases, language].forEach((result, index) => {
        const operations = ['sentiment', 'entities', 'keyPhrases', 'language'];
        if (result.status === 'rejected') {
          logger.warn(`${operations[index]} analysis failed`, { error: result.reason?.message });
        }
      });

      logger.info('Text analysis completed', { 
        sentiment: !!analysis.sentiment,
        entitiesCount: analysis.entities.length,
        keyPhrasesCount: analysis.keyPhrases.length,
        detectedLanguage: analysis.detectedLanguage?.LanguageCode
      });

      return analysis;
    } catch (error) {
      logger.error('Error analyzing text with Comprehend', { error: error.message });
      throw new Error(`Failed to analyze text: ${error.message}`);
    }
  }

  /**
   * Detects sentiment in text
   * @param {string} text - Text to analyze
   * @param {string} languageCode - Language code
   * @returns {Promise<Object>} - Sentiment analysis results
   */
  async detectSentiment(text, languageCode = 'en') {
    try {
      const command = new DetectSentimentCommand({
        Text: text,
        LanguageCode: languageCode
      });

      const response = await comprehendClient.send(command);
      
      return {
        sentiment: response.Sentiment,
        sentimentScore: response.SentimentScore,
        confidence: Math.max(...Object.values(response.SentimentScore))
      };
    } catch (error) {
      logger.error('Error detecting sentiment', { error: error.message });
      throw error;
    }
  }

  /**
   * Detects named entities in text
   * @param {string} text - Text to analyze
   * @param {string} languageCode - Language code
   * @returns {Promise<Array>} - Entities found
   */
  async detectEntities(text, languageCode = 'en') {
    try {
      const command = new DetectEntitiesCommand({
        Text: text,
        LanguageCode: languageCode
      });

      const response = await comprehendClient.send(command);
      
      return response.Entities.map(entity => ({
        text: entity.Text,
        type: entity.Type,
        score: entity.Score,
        beginOffset: entity.BeginOffset,
        endOffset: entity.EndOffset
      }));
    } catch (error) {
      logger.error('Error detecting entities', { error: error.message });
      throw error;
    }
  }

  /**
   * Detects key phrases in text
   * @param {string} text - Text to analyze
   * @param {string} languageCode - Language code
   * @returns {Promise<Array>} - Key phrases found
   */
  async detectKeyPhrases(text, languageCode = 'en') {
    try {
      const command = new DetectKeyPhrasesCommand({
        Text: text,
        LanguageCode: languageCode
      });

      const response = await comprehendClient.send(command);
      
      return response.KeyPhrases.map(phrase => ({
        text: phrase.Text,
        score: phrase.Score,
        beginOffset: phrase.BeginOffset,
        endOffset: phrase.EndOffset
      }));
    } catch (error) {
      logger.error('Error detecting key phrases', { error: error.message });
      throw error;
    }
  }

  /**
   * Detects the dominant language in text
   * @param {string} text - Text to analyze
   * @returns {Promise<Object>} - Language detection results
   */
  async detectDominantLanguage(text) {
    try {
      const command = new DetectDominantLanguageCommand({
        Text: text
      });

      const response = await comprehendClient.send(command);
      
      // Return the most confident language
      const dominantLanguage = response.Languages.reduce((prev, current) => 
        (prev.Score > current.Score) ? prev : current
      );

      return dominantLanguage;
    } catch (error) {
      logger.error('Error detecting dominant language', { error: error.message });
      throw error;
    }
  }

  /**
   * Generates a human-readable summary of the analysis
   * @param {Object} sentiment - Sentiment analysis results
   * @param {Array} entities - Entities found
   * @param {Array} keyPhrases - Key phrases found
   * @returns {string} - Summary text
   */
  generateSummary(sentiment, entities, keyPhrases) {
    let summary = '';

    if (sentiment) {
      summary += `The content has a ${sentiment.sentiment.toLowerCase()} sentiment (${(sentiment.confidence * 100).toFixed(1)}% confidence). `;
    }

    if (entities.length > 0) {
      const topEntities = entities
        .filter(e => e.score > 0.8)
        .slice(0, 5)
        .map(e => `${e.text} (${e.type})`)
        .join(', ');
      
      if (topEntities) {
        summary += `Key entities mentioned: ${topEntities}. `;
      }
    }

    if (keyPhrases.length > 0) {
      const topPhrases = keyPhrases
        .filter(p => p.score > 0.8)
        .slice(0, 3)
        .map(p => p.text)
        .join(', ');
      
      if (topPhrases) {
        summary += `Important topics: ${topPhrases}.`;
      }
    }

    return summary.trim() || 'No significant insights detected from the content.';
  }

  /**
   * Creates comprehensive AI-ready context from file content
   * @param {string} fileContent - Content extracted from file
   * @param {string} fileName - Original file name
   * @param {string} fileType - File type/extension
   * @returns {Promise<Object>} - Comprehensive AI context
   */
  async analyzeEventFile(fileContent, fileName, fileType) {
    try {
      logger.info('Creating comprehensive AI context for file', { fileName, fileType });

      // Get basic analysis
      const analysis = await this.analyzeText(fileContent);
      
      // Create comprehensive context
      const aiContext = {
        fileName,
        fileType,
        contentLength: fileContent.length,
        
        // Basic analysis results
        ...analysis,
        
        // Enhanced context for AI
        structuredContent: this.extractStructuredContent(fileContent, fileName),
        eventRelevance: this.assessEventRelevance(analysis),
        keyInformation: this.extractKeyInformation(analysis, fileContent),
        contextSummary: this.generateAIContextSummary(analysis, fileContent, fileName),
        actionableInsights: this.generateActionableInsights(analysis, fileContent),
        relatedConcepts: this.identifyRelatedConcepts(analysis),
        
        // AI-specific enhancements
        aiReadyContext: this.formatForAIAgent(analysis, fileContent, fileName),
        searchableKeywords: this.generateSearchableKeywords(analysis, fileContent),
        
        processedAt: new Date().toISOString()
      };

      logger.info('AI context creation completed', { 
        fileName,
        relevanceScore: aiContext.eventRelevance.score,
        keyInformationItems: aiContext.keyInformation.length,
        searchableKeywords: aiContext.searchableKeywords.length
      });

      return aiContext;
    } catch (error) {
      logger.error('Error creating AI context for file', { fileName, error: error.message });
      throw new Error(`Failed to create AI context: ${error.message}`);
    }
  }

  /**
   * Assesses how relevant the content is to event planning
   * @param {Object} analysis - Comprehend analysis results
   * @returns {Object} - Relevance assessment
   */
  assessEventRelevance(analysis) {
    const eventKeywords = [
      'event', 'venue', 'attendee', 'ticket', 'schedule', 'program', 
      'speaker', 'performance', 'crowd', 'capacity', 'logistics',
      'catering', 'security', 'stage', 'booth', 'registration',
      'conference', 'concert', 'festival', 'meeting', 'ceremony'
    ];

    let relevanceScore = 0;
    const matchedKeywords = [];

    // Check entities for event-related terms
    analysis.entities.forEach(entity => {
      if (eventKeywords.some(keyword => 
        entity.text.toLowerCase().includes(keyword) || 
        keyword.includes(entity.text.toLowerCase())
      )) {
        relevanceScore += entity.score * 0.3;
        matchedKeywords.push(entity.text);
      }
    });

    // Check key phrases for event-related terms
    analysis.keyPhrases.forEach(phrase => {
      if (eventKeywords.some(keyword => 
        phrase.text.toLowerCase().includes(keyword)
      )) {
        relevanceScore += phrase.score * 0.2;
        matchedKeywords.push(phrase.text);
      }
    });

    return {
      score: Math.min(relevanceScore, 1.0), // Cap at 1.0
      level: relevanceScore > 0.7 ? 'HIGH' : relevanceScore > 0.4 ? 'MEDIUM' : 'LOW',
      matchedKeywords: [...new Set(matchedKeywords)] // Remove duplicates
    };
  }

  /**
   * Generates event planning recommendations based on analysis
   * @param {Object} analysis - Comprehend analysis results
   * @returns {Array} - Array of recommendations
   */
  generateEventRecommendations(analysis) {
    const recommendations = [];

    if (analysis.sentiment?.sentiment === 'NEGATIVE') {
      recommendations.push({
        type: 'ATTENTION',
        message: 'Document contains negative sentiment - review for potential issues or concerns'
      });
    }

    if (analysis.entities.some(e => e.type === 'PERSON')) {
      recommendations.push({
        type: 'CONTACT',
        message: 'Key people identified - consider adding to event contact list'
      });
    }

    if (analysis.entities.some(e => e.type === 'LOCATION')) {
      recommendations.push({
        type: 'VENUE',
        message: 'Locations mentioned - verify venue details and logistics'
      });
    }

    if (analysis.entities.some(e => e.type === 'DATE')) {
      recommendations.push({
        type: 'SCHEDULE',
        message: 'Dates mentioned - cross-reference with event timeline'
      });
    }

    return recommendations;
  }

  /**
   * Extracts structured content patterns from raw text
   * @param {string} content - Raw file content
   * @param {string} fileName - File name for context
   * @returns {Object} - Structured content analysis
   */
  extractStructuredContent(content, fileName) {
    const structured = {
      sections: [],
      lists: [],
      tables: [],
      dates: [],
      numbers: [],
      urls: [],
      emails: [],
      csvData: null,
      scheduleItems: [],
      locations: [],
      people: [],
      timeSlots: []
    };

    // Check if this is CSV content
    if (content.includes('[CSV FILE:') || fileName.toLowerCase().endsWith('.csv')) {
      structured.csvData = this.extractCsvStructure(content);
    }

    // Extract sections (headers, titles)
    const sectionMatches = content.match(/^[A-Z][A-Z\s]{3,}$/gm) || [];
    structured.sections = sectionMatches.slice(0, 10);

    // Extract lists (bullet points, numbered items)
    const listMatches = content.match(/^[\s]*[-*•]\s+.+$/gm) || [];
    const numberedMatches = content.match(/^[\s]*\d+[\.)]\s+.+$/gm) || [];
    structured.lists = [...listMatches, ...numberedMatches].slice(0, 20);

    // Extract table-like structures and CSV records
    const tableMatches = content.match(/^.+\t.+$/gm) || [];
    const csvRecordMatches = content.match(/^Record \d+:$/gm) || [];
    structured.tables = [...tableMatches, ...csvRecordMatches].slice(0, 20);

    // Extract dates (enhanced for event schedules)
    const dateMatches = content.match(/\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b|\b\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}\b|\b[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}\b/g) || [];
    structured.dates = [...new Set(dateMatches)].slice(0, 10);

    // Extract time slots for event schedules
    const timeMatches = content.match(/\b\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?\b/g) || [];
    structured.timeSlots = [...new Set(timeMatches)].slice(0, 20);

    // Extract schedule items (time + activity patterns)
    const scheduleMatches = content.match(/\d{1,2}:\d{2}[^,\n]*(?:,|\n)/g) || [];
    structured.scheduleItems = scheduleMatches.slice(0, 15);

    // Extract locations (enhanced for event venues)
    const locationKeywords = ['room', 'hall', 'stage', 'area', 'venue', 'building', 'floor', 'auditorium', 'ballroom', 'conference'];
    const locationMatches = [];
    locationKeywords.forEach(keyword => {
      const regex = new RegExp(`\\b[^,\n]*${keyword}[^,\n]*\\b`, 'gi');
      const matches = content.match(regex) || [];
      locationMatches.push(...matches);
    });
    structured.locations = [...new Set(locationMatches)].slice(0, 10);

    // Extract people/roles (enhanced for event staff)
    const peopleKeywords = ['manager', 'team', 'host', 'speaker', 'coordinator', 'staff', 'volunteer', 'organizer', 'presenter', 'moderator'];
    const peopleMatches = [];
    peopleKeywords.forEach(keyword => {
      const regex = new RegExp(`\\b[^,\n]*${keyword}[^,\n]*\\b`, 'gi');
      const matches = content.match(regex) || [];
      peopleMatches.push(...matches);
    });
    structured.people = [...new Set(peopleMatches)].slice(0, 10);

    // Extract significant numbers
    const numberMatches = content.match(/\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b/g) || [];
    structured.numbers = [...new Set(numberMatches)].slice(0, 15);

    // Extract URLs
    const urlMatches = content.match(/https?:\/\/[^\s]+/g) || [];
    structured.urls = [...new Set(urlMatches)].slice(0, 5);

    // Extract email addresses
    const emailMatches = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    structured.emails = [...new Set(emailMatches)].slice(0, 10);

    return structured;
  }

  /**
   * Extracts CSV-specific structure information
   * @param {string} content - CSV file content
   * @returns {Object} - CSV structure analysis
   */
  extractCsvStructure(content) {
    const csvInfo = {
      hasHeaders: false,
      columnCount: 0,
      rowCount: 0,
      headers: [],
      sampleData: [],
      dataTypes: {}
    };

    // Extract header information
    const headerMatch = content.match(/Column Headers: ([^\n]+)/);
    if (headerMatch) {
      csvInfo.hasHeaders = true;
      csvInfo.headers = headerMatch[1].split(', ').map(h => h.trim());
      csvInfo.columnCount = csvInfo.headers.length;
    }

    // Extract row count
    const rowMatch = content.match(/Rows: (\d+)/);
    if (rowMatch) {
      csvInfo.rowCount = parseInt(rowMatch[1]);
    }

    // Extract sample data from structured records
    const recordMatches = content.match(/Record \d+:([\s\S]*?)(?=Record \d+:|=== CONTENT ANALYSIS ===|$)/g) || [];
    csvInfo.sampleData = recordMatches.slice(0, 3).map(record => {
      const lines = record.split('\n').filter(line => line.trim() && !line.includes('Record'));
      const recordData = {};
      lines.forEach(line => {
        const [key, ...valueParts] = line.split(':');
        if (key && valueParts.length > 0) {
          recordData[key.trim()] = valueParts.join(':').trim();
        }
      });
      return recordData;
    });

    return csvInfo;
  }

  /**
   * Extracts key information items from analysis and content
   * @param {Object} analysis - Comprehend analysis results
   * @param {string} content - Raw content
   * @returns {Array} - Array of key information items
   */
  extractKeyInformation(analysis, content) {
    const keyInfo = [];

    // High-confidence entities
    if (analysis.entities) {
      analysis.entities
        .filter(entity => entity.score > 0.8)
        .forEach(entity => {
          keyInfo.push({
            type: 'entity',
            category: entity.type,
            text: entity.text,
            confidence: entity.score,
            importance: 'high'
          });
        });
    }

    // High-confidence key phrases
    if (analysis.keyPhrases) {
      analysis.keyPhrases
        .filter(phrase => phrase.score > 0.8)
        .slice(0, 10)
        .forEach(phrase => {
          keyInfo.push({
            type: 'key_phrase',
            category: 'topic',
            text: phrase.text,
            confidence: phrase.score,
            importance: 'medium'
          });
        });
    }

    // Important numbers and dates from structured content
    const structured = this.extractStructuredContent(content, '');
    structured.dates.forEach(date => {
      keyInfo.push({
        type: 'date',
        category: 'temporal',
        text: date,
        confidence: 1.0,
        importance: 'high'
      });
    });

    // Contact information
    structured.emails.forEach(email => {
      keyInfo.push({
        type: 'contact',
        category: 'email',
        text: email,
        confidence: 1.0,
        importance: 'medium'
      });
    });

    return keyInfo;
  }

  /**
   * Generates comprehensive AI context summary
   * @param {Object} analysis - Comprehend analysis results
   * @param {string} content - Raw content
   * @param {string} fileName - File name
   * @returns {string} - AI-ready context summary
   */
  generateAIContextSummary(analysis, content, fileName) {
    let summary = `DOCUMENT: ${fileName}\n\n`;
    
    // Content overview
    summary += `CONTENT OVERVIEW:\n`;
    summary += `- Length: ${content.length} characters\n`;
    summary += `- Language: ${analysis.detectedLanguage?.LanguageCode || 'unknown'}\n`;
    
    if (analysis.sentiment) {
      summary += `- Overall tone: ${analysis.sentiment.sentiment.toLowerCase()}\n`;
    }

    // Key topics
    if (analysis.keyPhrases && analysis.keyPhrases.length > 0) {
      const topPhrases = analysis.keyPhrases
        .filter(p => p.score > 0.7)
        .slice(0, 5)
        .map(p => p.text);
      
      if (topPhrases.length > 0) {
        summary += `- Main topics: ${topPhrases.join(', ')}\n`;
      }
    }

    // Important entities
    if (analysis.entities && analysis.entities.length > 0) {
      const entityTypes = {};
      analysis.entities
        .filter(e => e.score > 0.8)
        .forEach(entity => {
          if (!entityTypes[entity.type]) entityTypes[entity.type] = [];
          entityTypes[entity.type].push(entity.text);
        });

      Object.keys(entityTypes).forEach(type => {
        const items = entityTypes[type].slice(0, 3);
        summary += `- ${type.toLowerCase()}s mentioned: ${items.join(', ')}\n`;
      });
    }

    // Event relevance
    const relevance = this.assessEventRelevance(analysis);
    summary += `- Event relevance: ${relevance.level} (${(relevance.score * 100).toFixed(0)}%)\n`;

    // Structured content
    const structured = this.extractStructuredContent(content, fileName);
    if (structured.dates.length > 0) {
      summary += `- Important dates: ${structured.dates.slice(0, 3).join(', ')}\n`;
    }
    if (structured.emails.length > 0) {
      summary += `- Contact emails: ${structured.emails.slice(0, 2).join(', ')}\n`;
    }

    summary += '\n';
    return summary;
  }

  /**
   * Generates actionable insights from content
   * @param {Object} analysis - Comprehend analysis results
   * @param {string} content - Raw content
   * @returns {Array} - Array of actionable insights
   */
  generateActionableInsights(analysis, content) {
    const insights = [];

    // Sentiment-based insights
    if (analysis.sentiment) {
      if (analysis.sentiment.sentiment === 'NEGATIVE') {
        insights.push({
          type: 'attention_required',
          priority: 'high',
          message: 'Document contains negative sentiment - review for potential issues or concerns',
          category: 'risk_management'
        });
      } else if (analysis.sentiment.sentiment === 'POSITIVE') {
        insights.push({
          type: 'positive_indicator',
          priority: 'medium',
          message: 'Document has positive tone - may indicate successful planning or good feedback',
          category: 'quality_indicator'
        });
      }
    }

    // Entity-based insights
    if (analysis.entities) {
      const entityTypes = {};
      analysis.entities.forEach(entity => {
        if (!entityTypes[entity.type]) entityTypes[entity.type] = [];
        entityTypes[entity.type].push(entity);
      });

      // Person entities
      if (entityTypes.PERSON && entityTypes.PERSON.length > 0) {
        insights.push({
          type: 'stakeholder_identification',
          priority: 'medium',
          message: `${entityTypes.PERSON.length} people identified - consider adding to event contact list`,
          category: 'stakeholder_management',
          details: entityTypes.PERSON.slice(0, 5).map(p => p.text)
        });
      }

      // Location entities
      if (entityTypes.LOCATION && entityTypes.LOCATION.length > 0) {
        insights.push({
          type: 'location_reference',
          priority: 'high',
          message: `${entityTypes.LOCATION.length} locations mentioned - verify venue details and logistics`,
          category: 'venue_management',
          details: entityTypes.LOCATION.slice(0, 3).map(l => l.text)
        });
      }

      // Date entities
      if (entityTypes.DATE && entityTypes.DATE.length > 0) {
        insights.push({
          type: 'schedule_reference',
          priority: 'high',
          message: `${entityTypes.DATE.length} dates mentioned - cross-reference with event timeline`,
          category: 'schedule_management',
          details: entityTypes.DATE.slice(0, 3).map(d => d.text)
        });
      }

      // Organization entities
      if (entityTypes.ORGANIZATION && entityTypes.ORGANIZATION.length > 0) {
        insights.push({
          type: 'vendor_partner_identification',
          priority: 'medium',
          message: `${entityTypes.ORGANIZATION.length} organizations mentioned - potential vendors or partners`,
          category: 'vendor_management',
          details: entityTypes.ORGANIZATION.slice(0, 3).map(o => o.text)
        });
      }
    }

    // Content structure insights
    const structured = this.extractStructuredContent(content, '');
    if (structured.lists.length > 5) {
      insights.push({
        type: 'structured_information',
        priority: 'low',
        message: 'Document contains multiple lists - well-organized information for planning',
        category: 'information_quality'
      });
    }

    if (structured.tables.length > 0) {
      insights.push({
        type: 'tabular_data',
        priority: 'medium',
        message: `Document contains ${structured.tables.length} tables - structured data for analysis`,
        category: 'data_availability'
      });
    }

    return insights;
  }

  /**
   * Identifies related concepts and themes
   * @param {Object} analysis - Comprehend analysis results
   * @returns {Object} - Related concepts and themes
   */
  identifyRelatedConcepts(analysis) {
    const concepts = {
      eventManagement: [],
      logistics: [],
      communication: [],
      safety: [],
      technology: [],
      finance: [],
      marketing: []
    };

    // Event management keywords
    const eventKeywords = ['event', 'conference', 'meeting', 'seminar', 'workshop', 'ceremony', 'celebration', 'festival', 'concert'];
    const logisticsKeywords = ['venue', 'catering', 'transportation', 'accommodation', 'setup', 'equipment', 'schedule', 'timeline'];
    const communicationKeywords = ['announcement', 'invitation', 'notification', 'marketing', 'promotion', 'social media', 'website'];
    const safetyKeywords = ['security', 'safety', 'emergency', 'medical', 'evacuation', 'protocol', 'insurance'];
    const technologyKeywords = ['system', 'software', 'platform', 'digital', 'online', 'virtual', 'streaming', 'registration'];
    const financeKeywords = ['budget', 'cost', 'payment', 'invoice', 'expense', 'revenue', 'pricing', 'fee'];
    const marketingKeywords = ['promotion', 'advertising', 'branding', 'social media', 'press release', 'publicity'];

    // Analyze key phrases and entities
    const allText = [];
    if (analysis.keyPhrases) {
      allText.push(...analysis.keyPhrases.map(p => p.text.toLowerCase()));
    }
    if (analysis.entities) {
      allText.push(...analysis.entities.map(e => e.text.toLowerCase()));
    }

    const textString = allText.join(' ');

    // Categorize concepts
    eventKeywords.forEach(keyword => {
      if (textString.includes(keyword)) concepts.eventManagement.push(keyword);
    });
    logisticsKeywords.forEach(keyword => {
      if (textString.includes(keyword)) concepts.logistics.push(keyword);
    });
    communicationKeywords.forEach(keyword => {
      if (textString.includes(keyword)) concepts.communication.push(keyword);
    });
    safetyKeywords.forEach(keyword => {
      if (textString.includes(keyword)) concepts.safety.push(keyword);
    });
    technologyKeywords.forEach(keyword => {
      if (textString.includes(keyword)) concepts.technology.push(keyword);
    });
    financeKeywords.forEach(keyword => {
      if (textString.includes(keyword)) concepts.finance.push(keyword);
    });
    marketingKeywords.forEach(keyword => {
      if (textString.includes(keyword)) concepts.marketing.push(keyword);
    });

    return concepts;
  }

  /**
   * Formats content specifically for AI agent consumption
   * @param {Object} analysis - Comprehend analysis results
   * @param {string} content - Raw content
   * @param {string} fileName - File name
   * @returns {string} - AI-optimized context
   */
  formatForAIAgent(analysis, content, fileName) {
    let aiContext = `=== AI AGENT CONTEXT FOR: ${fileName} ===\n\n`;
    
    // Quick facts section
    aiContext += `QUICK FACTS:\n`;
    aiContext += `• Document type: ${this.inferDocumentType(content, fileName)}\n`;
    aiContext += `• Content length: ${content.length} characters\n`;
    aiContext += `• Language: ${analysis.detectedLanguage?.LanguageCode || 'unknown'}\n`;
    
    if (analysis.sentiment) {
      aiContext += `• Tone: ${analysis.sentiment.sentiment} (${(analysis.sentiment.confidence * 100).toFixed(0)}% confidence)\n`;
    }

    const relevance = this.assessEventRelevance(analysis);
    aiContext += `• Event relevance: ${relevance.level}\n\n`;

    // Key information for AI queries
    aiContext += `KEY INFORMATION FOR AI QUERIES:\n`;
    
    // Entities organized by type
    if (analysis.entities && analysis.entities.length > 0) {
      const entityGroups = {};
      analysis.entities
        .filter(e => e.score > 0.7)
        .forEach(entity => {
          if (!entityGroups[entity.type]) entityGroups[entity.type] = [];
          entityGroups[entity.type].push(entity.text);
        });

      Object.keys(entityGroups).forEach(type => {
        aiContext += `• ${type}: ${entityGroups[type].join(', ')}\n`;
      });
    }

    // Important topics
    if (analysis.keyPhrases && analysis.keyPhrases.length > 0) {
      const topTopics = analysis.keyPhrases
        .filter(p => p.score > 0.8)
        .slice(0, 8)
        .map(p => p.text);
      
      if (topTopics.length > 0) {
        aiContext += `• Key topics: ${topTopics.join(', ')}\n`;
      }
    }

    // Structured data
    const structured = this.extractStructuredContent(content, fileName);
    
    // CSV-specific information
    if (structured.csvData) {
      aiContext += `• CSV structure: ${structured.csvData.rowCount} rows, ${structured.csvData.columnCount} columns\n`;
      if (structured.csvData.headers.length > 0) {
        aiContext += `• Data fields: ${structured.csvData.headers.join(', ')}\n`;
      }
    }
    
    // Time-based information (important for event schedules)
    if (structured.timeSlots.length > 0) {
      aiContext += `• Time slots: ${structured.timeSlots.join(', ')}\n`;
    }
    
    // Location information
    if (structured.locations.length > 0) {
      aiContext += `• Locations mentioned: ${structured.locations.slice(0, 5).join(', ')}\n`;
    }
    
    // People/roles information
    if (structured.people.length > 0) {
      aiContext += `• People/Roles: ${structured.people.slice(0, 5).join(', ')}\n`;
    }
    
    // Dates and schedule items
    if (structured.dates.length > 0) {
      aiContext += `• Important dates: ${structured.dates.join(', ')}\n`;
    }
    if (structured.scheduleItems.length > 0) {
      aiContext += `• Schedule items: ${structured.scheduleItems.slice(0, 3).join('; ')}\n`;
    }
    
    // Contact and reference information
    if (structured.emails.length > 0) {
      aiContext += `• Contact information: ${structured.emails.join(', ')}\n`;
    }
    if (structured.urls.length > 0) {
      aiContext += `• Referenced URLs: ${structured.urls.join(', ')}\n`;
    }

    aiContext += '\n';

    // Context for common AI queries
    aiContext += `CONTEXT FOR COMMON QUERIES:\n`;
    aiContext += `• "What is this document about?": ${this.generateDocumentSummary(analysis, content, structured)}\n`;
    aiContext += `• "Who are the key people?": ${this.extractKeyPeople(analysis, structured)}\n`;
    aiContext += `• "What are the important dates?": ${structured.dates.join(', ') || 'No specific dates found'}\n`;
    aiContext += `• "What times are mentioned?": ${structured.timeSlots.join(', ') || 'No specific times found'}\n`;
    aiContext += `• "What locations are mentioned?": ${this.extractLocations(analysis, structured)}\n`;
    aiContext += `• "What actions are needed?": ${this.extractActionItems(content)}\n`;
    
    // CSV-specific queries
    if (structured.csvData) {
      aiContext += `• "What is the schedule?": Event schedule with ${structured.csvData.rowCount - 1} activities from ${structured.timeSlots[0] || 'start'} to ${structured.timeSlots[structured.timeSlots.length - 1] || 'end'}\n`;
      aiContext += `• "What data is available?": CSV contains ${structured.csvData.headers.join(', ')} for ${structured.csvData.rowCount - 1} records\n`;
    }
    
    aiContext += '\n';

    return aiContext;
  }

  /**
   * Generates searchable keywords for efficient retrieval
   * @param {Object} analysis - Comprehend analysis results
   * @param {string} content - Raw content
   * @returns {Array} - Array of searchable keywords
   */
  generateSearchableKeywords(analysis, content) {
    const keywords = new Set();

    // Add entities
    if (analysis.entities) {
      analysis.entities
        .filter(e => e.score > 0.7)
        .forEach(entity => {
          keywords.add(entity.text.toLowerCase());
          // Add individual words from multi-word entities
          entity.text.toLowerCase().split(/\s+/).forEach(word => {
            if (word.length > 2) keywords.add(word);
          });
        });
    }

    // Add key phrases
    if (analysis.keyPhrases) {
      analysis.keyPhrases
        .filter(p => p.score > 0.7)
        .forEach(phrase => {
          keywords.add(phrase.text.toLowerCase());
          // Add individual words
          phrase.text.toLowerCase().split(/\s+/).forEach(word => {
            if (word.length > 2) keywords.add(word);
          });
        });
    }

    // Add structured content
    const structured = this.extractStructuredContent(content, '');
    structured.dates.forEach(date => keywords.add(date));
    structured.emails.forEach(email => keywords.add(email));

    // Add document type keywords
    const docType = this.inferDocumentType(content, '');
    keywords.add(docType);

    return Array.from(keywords).slice(0, 50); // Limit to 50 keywords
  }

  /**
   * Helper methods for AI context formatting
   */
  inferDocumentType(content, fileName) {
    const extension = fileName.split('.').pop()?.toLowerCase();
    if (extension === 'pdf') return 'PDF document';
    if (['xlsx', 'xls'].includes(extension)) return 'Excel spreadsheet';
    if (extension === 'csv') return 'CSV data file';
    if (extension === 'docx') return 'Word document';
    if (['jpg', 'jpeg', 'png'].includes(extension)) return 'image with text';
    
    // Infer from content
    if (content.includes('[CSV FILE:')) return 'CSV event schedule';
    if (content.includes('WORKSHEET') || content.includes('\t')) return 'structured data';
    if (content.includes('--- EXTRACTED CONTENT ---')) return 'processed document';
    return 'text document';
  }

  generateDocumentSummary(analysis, content, structured) {
    // For CSV files, provide specific summary
    if (structured && structured.csvData) {
      const headers = structured.csvData.headers;
      const rowCount = structured.csvData.rowCount - 1; // Exclude header
      
      // Detect if it's a schedule/event file
      const scheduleIndicators = ['time', 'activity', 'location', 'responsible', 'notes', 'schedule', 'event'];
      const hasScheduleFields = headers.some(header => 
        scheduleIndicators.some(indicator => header.toLowerCase().includes(indicator))
      );
      
      if (hasScheduleFields) {
        return `Event schedule with ${rowCount} activities covering times, locations, and responsibilities`;
      } else {
        return `Structured data file with ${rowCount} records containing ${headers.join(', ')}`;
      }
    }
    
    // Default analysis-based summary
    if (analysis.keyPhrases && analysis.keyPhrases.length > 0) {
      const topPhrases = analysis.keyPhrases
        .filter(p => p.score > 0.8)
        .slice(0, 3)
        .map(p => p.text);
      return `Document focuses on: ${topPhrases.join(', ')}`;
    }
    return 'Document content analysis available';
  }

  extractKeyPeople(analysis, structured) {
    const allPeople = [];
    
    // Get people from Comprehend entities
    if (analysis.entities) {
      const people = analysis.entities
        .filter(e => e.type === 'PERSON' && e.score > 0.8)
        .map(e => e.text);
      allPeople.push(...people);
    }
    
    // Get people from structured content (roles, teams, etc.)
    if (structured && structured.people) {
      allPeople.push(...structured.people.slice(0, 3));
    }
    
    const uniquePeople = [...new Set(allPeople)].slice(0, 5);
    return uniquePeople.length > 0 ? uniquePeople.join(', ') : 'No specific people identified';
  }

  extractLocations(analysis, structured) {
    const allLocations = [];
    
    // Get locations from Comprehend entities
    if (analysis.entities) {
      const locations = analysis.entities
        .filter(e => e.type === 'LOCATION' && e.score > 0.8)
        .map(e => e.text);
      allLocations.push(...locations);
    }
    
    // Get locations from structured content
    if (structured && structured.locations) {
      allLocations.push(...structured.locations.slice(0, 3));
    }
    
    const uniqueLocations = [...new Set(allLocations)].slice(0, 5);
    return uniqueLocations.length > 0 ? uniqueLocations.join(', ') : 'No specific locations identified';
  }

  extractActionItems(content) {
    // Look for action-oriented language
    const actionPatterns = [
      /(?:need to|must|should|required to|action:)\s+([^.!?]+)/gi,
      /(?:todo|to do|action item):\s*([^.!?]+)/gi,
      /(?:follow up|follow-up):\s*([^.!?]+)/gi
    ];

    const actions = [];
    actionPatterns.forEach(pattern => {
      const matches = content.match(pattern);
      if (matches) actions.push(...matches.slice(0, 3));
    });

    return actions.length > 0 ? actions.join('; ') : 'No specific action items identified';
  }
}

module.exports = new ComprehendService();
