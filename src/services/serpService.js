const axios = require('axios');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'serp-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

class SerpService {
  constructor() {
    this.apiKey = process.env.SERP_API_KEY;
    this.apiBaseUrl = 'https://serpapi.com/search.json'; // Use .json endpoint like frontend
    this.timeout = 30000; // 30 seconds
    
    logger.info('🔧 [SerpAPI] Initializing service', {
      apiKeyExists: !!this.apiKey,
      apiKeyLength: this.apiKey?.length,
      apiKeyPreview: this.apiKey ? `${this.apiKey.substring(0, 10)}...` : 'NOT SET',
      baseUrl: this.apiBaseUrl
    });
    
    if (!this.apiKey) {
      logger.warn('⚠️ [SerpAPI] SERP_API_KEY not configured. Serp API calls will fail.');
    }
  }

  /**
   * Search for nearby events using Google Serp API
   * Following the frontend implementation pattern
   * @param {Object} eventData - Event data (name, venue, date, location)
   * @returns {Promise<Object>} - Nearby events search results
   */
  async searchNearbyEvents(eventData) {
    try {
      logger.info('🎯 [SerpAPI] searchNearbyEvents called', {
        eventName: eventData.name,
        venue: eventData.venue,
        date: eventData.dateOfEventStart
      });

      if (!this.apiKey) {
        throw new Error('SERP_API_KEY is not configured in environment variables');
      }

      // Format the date for better search results (matching frontend pattern)
      const eventDate = new Date(eventData.dateOfEventStart);
      const formattedDate = eventDate.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      });

      // Also get simpler date format (e.g., "9 October 2025")
      const simpleDateFormat = eventDate.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      });

      logger.info('📅 [SerpAPI] Formatted date', { 
        originalDate: eventData.dateOfEventStart,
        formattedDate,
        simpleDateFormat
      });

      // Try more natural query format to trigger AI Overview
      // Use "nearby event at" instead of "events near" (like user's manual search)
      const query = `nearby event at ${eventData.venue} on ${simpleDateFormat}`;

      logger.info('🔍 [SerpAPI] Constructed query', { query });

      // Use a generic location that SerpAPI supports (matching frontend)
      // Always use "Kuala Lumpur, Malaysia" as it's more likely to be recognized
      const supportedLocation = 'Kuala Lumpur, Malaysia';

      const searchParams = {
        api_key: this.apiKey,
        engine: 'google',
        q: query,
        location: supportedLocation, // Generic location for SerpAPI
        gl: 'us', // ✅ USE US for AI Overview support (my=Malaysia not supported)
        hl: 'en', // English language
        num: 10   // Get top 10 results
      };

      logger.info('⚙️ [SerpAPI] Search parameters', {
        ...searchParams,
        api_key: '***REDACTED***' // Don't log the API key
      });

      const serpUrl = this.apiBaseUrl;
      logger.info('📤 [SerpAPI] Sending request', { 
        url: serpUrl,
        method: 'GET'
      });

      logger.info('⏳ [SerpAPI] Sending fetch request...');
      const response = await axios.get(serpUrl, {
        params: searchParams,
        timeout: this.timeout,
        headers: {
          'Accept': 'application/json'
        }
      });

      logger.info('📥 [SerpAPI] Response received', {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });

      const data = response.data;

      logger.info('✅ [SerpAPI] Response Summary', {
        hasSearchMetadata: !!data.search_metadata,
        searchId: data.search_metadata?.id,
        hasAiOverview: !!data.ai_overview,
        aiOverviewError: data.ai_overview?.error,
        organicResultsCount: data.organic_results?.length || 0,
        eventsResultsCount: data.events_results?.length || 0,
        relatedSearchesCount: data.related_searches?.length || 0,
        totalResults: data.search_information?.total_results || 0,
        queryDisplayed: data.search_parameters?.q,
        error: data.error
      });

      // Check if AI Overview requires a second request
      if (data.ai_overview?.page_token && data.ai_overview?.serpapi_link) {
        logger.info('🔄 [SerpAPI] AI Overview requires second request', {
          hasPageToken: true,
          serpapi_link: data.ai_overview.serpapi_link.substring(0, 100) + '...'
        });

        try {
          // Fetch full AI Overview using page_token
          const aiOverviewData = await this.fetchAiOverview(data.ai_overview.page_token);
          if (aiOverviewData) {
            data.ai_overview = aiOverviewData;
            logger.info('✅ [SerpAPI] AI Overview fetched successfully', {
              textBlocksCount: aiOverviewData.text_blocks?.length || 0,
              referencesCount: aiOverviewData.references?.length || 0
            });
          }
        } catch (aiError) {
          logger.error('❌ [SerpAPI] Failed to fetch AI Overview', {
            error: aiError.message
          });
          // Keep the page_token response if second request fails
        }
      } else if (data.ai_overview) {
        logger.info('🤖 [SerpAPI] AI Overview Details', {
          hasPageToken: !!data.ai_overview.page_token,
          hasTextBlocks: !!data.ai_overview.text_blocks,
          textBlocksCount: data.ai_overview.text_blocks?.length || 0,
          referencesCount: data.ai_overview.references?.length || 0,
          error: data.ai_overview.error
        });
      }

      if (data.events_results && data.events_results.length > 0) {
        logger.info('📅 [SerpAPI] Events Results Found', {
          count: data.events_results.length,
          firstEvent: data.events_results[0]?.title
        });
      }

      if (data.organic_results && data.organic_results.length > 0) {
        logger.info('🌐 [SerpAPI] Organic Results Found', {
          count: data.organic_results.length,
          firstResult: data.organic_results[0]?.title
        });
      }

      // Check if AI Overview is empty and try alternative query if needed
      const hasAiContent = data.ai_overview?.text_blocks?.length > 0 || data.ai_overview?.references?.length > 0;
      
      if (!hasAiContent && !data.ai_overview?.page_token) {
        logger.warn('⚠️ [SerpAPI] No AI Overview content in response', {
          hasAiOverview: !!data.ai_overview,
          hasTextBlocks: !!data.ai_overview?.text_blocks,
          textBlocksLength: data.ai_overview?.text_blocks?.length || 0,
          note: 'AI Overview availability varies by query and Google algorithms'
        });

        // Try alternative query format for AI Overview
        const alternativeQuery = `what events happening at ${eventData.venue} on ${simpleDateFormat}`;
        logger.info('🔄 [SerpAPI] Trying alternative query for AI Overview', {
          alternativeQuery
        });

        try {
          const altResponse = await axios.get(this.apiBaseUrl, {
            params: {
              ...searchParams,
              q: alternativeQuery
            },
            timeout: this.timeout,
            headers: {
              'Accept': 'application/json'
            }
          });

          if (altResponse.data.ai_overview?.text_blocks?.length > 0) {
            logger.info('✅ [SerpAPI] AI Overview found with alternative query', {
              textBlocksCount: altResponse.data.ai_overview.text_blocks.length,
              alternativeQuery
            });
            
            // Merge AI Overview from alternative query with original results
            data.ai_overview = altResponse.data.ai_overview;
            
            // Also check for page_token in alternative response
            if (altResponse.data.ai_overview?.page_token && altResponse.data.ai_overview?.serpapi_link) {
              logger.info('🔄 [SerpAPI] Alternative query AI Overview requires second request');
              try {
                const aiOverviewData = await this.fetchAiOverview(altResponse.data.ai_overview.page_token);
                if (aiOverviewData) {
                  data.ai_overview = aiOverviewData;
                  logger.info('✅ [SerpAPI] AI Overview fetched successfully from alternative query');
                }
              } catch (aiError) {
                logger.error('❌ [SerpAPI] Failed to fetch AI Overview from alternative query', {
                  error: aiError.message
                });
              }
            }
          } else {
            logger.warn('⚠️ [SerpAPI] Alternative query also returned no AI Overview');
          }
        } catch (altError) {
          logger.error('❌ [SerpAPI] Alternative query failed', {
            error: altError.message
          });
          // Continue with original results even if alternative fails
        }
      }

      // Transform to our format
      const nearbyEvents = this.transformSerpResponse(data, eventData, query);

      logger.info('✅ [SerpAPI] Nearby events search completed', {
        eventName: eventData.name,
        resultsCount: nearbyEvents.results?.length || 0,
        success: nearbyEvents.serp_metadata.success
      });

      return nearbyEvents;

    } catch (error) {
      logger.error('❌ [SerpAPI] Search Error', {
        eventName: eventData.name,
        error: error.message,
        stack: error.stack
      });

      if (error.response) {
        logger.error('❌ [SerpAPI] Error Response', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        });
      }

      // Return error structure instead of throwing
      const query = `events near "${eventData.venue}" on ${new Date(eventData.dateOfEventStart).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
      
      return {
        search_query: query,
        search_timestamp: new Date().toISOString(),
        error: error.message,
        results: [],
        serp_metadata: {
          success: false,
          error_message: error.message,
          api_version: '1.0'
        }
      };
    }
  }

  /**
   * Fetch AI Overview using page_token
   * Google sometimes returns AI Overview through a separate request
   * @param {string} pageToken - The page token from initial response
   * @returns {Promise<Object|null>} - AI Overview data
   */
  async fetchAiOverview(pageToken) {
    try {
      logger.info('🔄 [SerpAPI] Fetching AI Overview with page_token', {
        tokenLength: pageToken.length,
        tokenPreview: pageToken.substring(0, 50) + '...'
      });

      const response = await axios.get(this.apiBaseUrl, {
        params: {
          api_key: this.apiKey,
          engine: 'google_ai_overview',
          page_token: pageToken
        },
        timeout: this.timeout,
        headers: {
          'Accept': 'application/json'
        }
      });

      logger.info('📥 [SerpAPI] AI Overview response received', {
        status: response.status,
        hasTextBlocks: !!response.data.text_blocks,
        textBlocksCount: response.data.text_blocks?.length || 0,
        hasReferences: !!response.data.references,
        referencesCount: response.data.references?.length || 0
      });

      return response.data;

    } catch (error) {
      logger.error('❌ [SerpAPI] Failed to fetch AI Overview', {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      return null;
    }
  }

  /**
   * Search Google via SerpAPI (generic search method)
   * @param {Object} params - Search parameters
   * @returns {Promise<Object>} - Serp API response
   */
  async searchGoogle(params) {
    try {
      logger.info('🚀 [SerpAPI] Starting search request');
      logger.info('🔑 [SerpAPI] API Key check', {
        exists: !!this.apiKey,
        length: this.apiKey?.length,
        preview: this.apiKey ? `${this.apiKey.substring(0, 10)}...` : 'NOT SET'
      });

      if (!this.apiKey) {
        throw new Error('SERP_API_KEY is not configured in environment variables');
      }

      const searchParams = {
        api_key: this.apiKey,
        engine: 'google',
        q: params.q,
        ...(params.location && { location: params.location }),
        ...(params.gl && { gl: params.gl }),
        ...(params.hl && { hl: params.hl }),
        ...(params.num && { num: params.num })
      };

      logger.info('📤 [SerpAPI] Request Details', {
        baseUrl: this.apiBaseUrl,
        query: params.q,
        location: params.location,
        gl: params.gl,
        hl: params.hl,
        num: params.num
      });

      logger.info('⏳ [SerpAPI] Sending fetch request...');
      const response = await axios.get(this.apiBaseUrl, {
        params: searchParams,
        timeout: this.timeout,
        headers: {
          'Accept': 'application/json'
        }
      });

      logger.info('📥 [SerpAPI] Response received', {
        status: response.status,
        statusText: response.statusText,
        ok: response.status >= 200 && response.status < 300
      });

      if (response.status !== 200) {
        throw new Error(`SerpAPI request failed: ${response.status} ${response.statusText}`);
      }

      const data = response.data;

      logger.info('✅ [SerpAPI] Parsed Response Data keys', {
        keys: Object.keys(data)
      });

      logger.info('✅ [SerpAPI] Response Summary', {
        hasSearchMetadata: !!data.search_metadata,
        searchId: data.search_metadata?.id,
        hasAiOverview: !!data.ai_overview,
        aiOverviewError: data.ai_overview?.error,
        organicResultsCount: data.organic_results?.length || 0,
        eventsResultsCount: data.events_results?.length || 0,
        relatedSearchesCount: data.related_searches?.length || 0,
        totalResults: data.search_information?.total_results || 0,
        queryDisplayed: data.search_parameters?.q,
        error: data.error
      });

      return data;

    } catch (error) {
      logger.error('❌ [SerpAPI] Search Error', {
        message: error.message,
        stack: error.stack
      });

      if (error.response) {
        logger.error('❌ [SerpAPI] Error Response', {
          status: error.response.status,
          data: error.response.data
        });
      }

      throw error;
    }
  }

  /**
   * Transform Serp API response to our format
   * Matches the frontend response structure
   * @param {Object} serpData - Raw Serp API response
   * @param {Object} eventData - Original event data
   * @param {string} query - Search query used
   * @returns {Object} - Transformed nearby events data
   */
  transformSerpResponse(serpData, eventData, query) {
    const results = [];

    // 📅 Priority 1: Extract event results (if Google shows event cards)
    // These are the most relevant for nearby events
    if (serpData.events_results && Array.isArray(serpData.events_results)) {
      logger.info('📅 [SerpAPI] Processing events_results', {
        count: serpData.events_results.length
      });

      serpData.events_results.forEach((event, index) => {
        results.push({
          type: 'event_result', // Mark as event result
          title: event.title || '',
          description: event.description || '',
          url: event.link || event.ticket_info?.[0]?.link || '',
          source: event.ticket_info?.[0]?.source || 'Google Events',
          position: index + 1,
          date: event.date?.start_date || event.date?.when || null,
          location: Array.isArray(event.address) ? event.address.join(', ') : (event.venue || event.address || null),
          thumbnail: event.thumbnail || null,
          venue: event.venue || null,
          ticket_info: event.ticket_info || null
        });
      });

      logger.info('✅ [SerpAPI] Processed events_results', {
        count: serpData.events_results.length
      });
    }

    // 🌐 Priority 2: Extract organic results (ENHANCED for frontend display)
    if (serpData.organic_results && Array.isArray(serpData.organic_results)) {
      logger.info('🌐 [SerpAPI] Processing organic_results', {
        count: serpData.organic_results.length
      });

      serpData.organic_results.forEach(result => {
        // Enhanced relevance scoring based on highlighted words and content
        const isHighlyRelevant = this.calculateRelevanceScore(result, eventData);
        
        // Only save results with relevance score >= 0.4 (40%)
        if (isHighlyRelevant.score >= 0.4) {
          results.push({
            type: 'organic_result', // Mark as organic result
            title: result.title || '',
            description: result.snippet || '',
            url: result.link || '',
            source: result.source || result.displayed_link || '',
            position: result.position || 0,
            date: result.date || this.extractDateFromSnippet(result.snippet),
            location: this.extractLocationFromSnippet(result.snippet),
            snippet_highlighted_words: result.snippet_highlighted_words || [],
            relevance_score: isHighlyRelevant.score,
            is_highly_relevant: isHighlyRelevant.score >= 0.6, // 60% threshold for "highly relevant"
            matched_keywords: isHighlyRelevant.matched_keywords
          });
        }
      });

      logger.info('✅ [SerpAPI] Processed organic_results', {
        total: serpData.organic_results.length,
        saved: results.filter(r => r.type === 'organic_result').length,
        filtered_out: serpData.organic_results.length - results.filter(r => r.type === 'organic_result').length,
        highly_relevant: results.filter(r => r.is_highly_relevant).length
      });
    }

    // 🤖 Include AI Overview if available (full structure matching SerpAPI docs)
    const ai_overview = serpData.ai_overview ? {
      text_blocks: serpData.ai_overview.text_blocks || [],
      thumbnail: serpData.ai_overview.thumbnail || null,
      references: serpData.ai_overview.references || [],
      // Metadata for quick checks
      has_overview: true,
      text_blocks_count: serpData.ai_overview.text_blocks?.length || 0,
      references_count: serpData.ai_overview.references?.length || 0,
      error: serpData.ai_overview.error || null,
      // Include page_token and serpapi_link if present (for debugging)
      page_token: serpData.ai_overview.page_token || null,
      serpapi_link: serpData.ai_overview.serpapi_link || null
    } : null;

    // Create frontend-friendly summary
    const highlyRelevantResults = results.filter(r => r.is_highly_relevant);
    const hasUsefulData = results.length > 0 || (ai_overview && ai_overview.text_blocks_count > 0);
    
    const transformedResponse = {
      search_query: query,
      search_timestamp: new Date().toISOString(),
      results,
      ai_overview,
      related_searches: serpData.related_searches || [],
      // NEW: Frontend summary for easier display
      summary: {
        has_ai_overview: !!(ai_overview && ai_overview.text_blocks_count > 0),
        has_events: results.some(r => r.type === 'event_result'),
        has_relevant_results: highlyRelevantResults.length > 0,
        total_results: results.length,
        highly_relevant_count: highlyRelevantResults.length,
        recommended_results: highlyRelevantResults.slice(0, 8), // Top 8 highly relevant (60%+)
        data_quality: hasUsefulData ? 
          (highlyRelevantResults.length >= 3 ? 'high' :     // 3+ results with 60%+ score = high quality
           highlyRelevantResults.length >= 1 ? 'medium' :    // 1-2 results = medium quality
           results.length > 0 ? 'low' : 'none') : 'none',    // Some 40%+ results = low, else none
        display_suggestion: this.getDisplaySuggestion(results, ai_overview)
      },
      serp_metadata: {
        api_version: '1.0',
        search_id: serpData.search_metadata?.id || null,
        total_results: serpData.search_information?.total_results || 0,
        search_time: serpData.search_information?.time_taken_displayed || 0,
        search_parameters: {
          engine: serpData.search_parameters?.engine || 'google',
          query: serpData.search_parameters?.q || query,
          location_requested: serpData.search_parameters?.location_requested || null,
          location_used: serpData.search_parameters?.location_used || null,
          gl: serpData.search_parameters?.gl || null,
          hl: serpData.search_parameters?.hl || null
        },
        success: true,
        organic_results_count: serpData.organic_results?.length || 0,
        events_results_count: serpData.events_results?.length || 0
      }
    };

    logger.info('🎉 [SerpAPI] Transform completed', {
      totalResults: results.length,
      eventsCount: results.filter(r => r.type === 'event_result').length,
      organicCount: results.filter(r => r.type === 'organic_result').length,
      hasAiOverview: !!ai_overview
    });

    return transformedResponse;
  }

  /**
   * Get display suggestion for frontend
   * @param {Array} results - Search results
   * @param {Object} ai_overview - AI Overview data
   * @returns {string} - Display suggestion
   */
  getDisplaySuggestion(results, ai_overview) {
    if (ai_overview && ai_overview.text_blocks_count > 0) {
      return 'show_ai_overview'; // Show AI Overview prominently (rare)
    }
    
    const eventResults = results.filter(r => r.type === 'event_result');
    if (eventResults.length > 0) {
      return 'show_event_cards'; // Show event cards
    }
    
    const relevantResults = results.filter(r => r.is_highly_relevant); // 60%+ score
    if (relevantResults.length >= 3) {
      return 'show_relevant_list'; // Show list of highly relevant results (60%+)
    }
    
    if (results.length > 0) {
      return 'show_search_results'; // Show moderately relevant results (40-60%)
    }
    
    return 'show_no_results'; // No useful data found
  }

  /**
   * Calculate relevance score for search result
   * @param {Object} result - Search result
   * @param {Object} eventData - Original event data
   * @returns {Object} - Relevance score and matched keywords
   */
  calculateRelevanceScore(result, eventData) {
    let score = 0;
    const matched_keywords = [];
    const venueName = eventData.venue.toLowerCase();
    const eventName = (eventData.name || '').toLowerCase();
    const resultText = `${result.title} ${result.snippet}`.toLowerCase();
    
    // Check for venue match (highest priority)
    if (resultText.includes(venueName)) {
      score += 0.4;
      matched_keywords.push('venue');
    }
    
    // Check for event name match
    if (eventName && resultText.includes(eventName)) {
      score += 0.3;
      matched_keywords.push('event_name');
    }
    
    // Check for date-related keywords
    const eventDate = new Date(eventData.dateOfEventStart);
    const month = eventDate.toLocaleString('en-US', { month: 'long' }).toLowerCase();
    const year = eventDate.getFullYear().toString();
    
    if (resultText.includes(month) && resultText.includes(year)) {
      score += 0.2;
      matched_keywords.push('date');
    }
    
    // Check for event-related keywords
    const eventKeywords = ['event', 'concert', 'show', 'festival', 'exhibition', 'conference'];
    const foundKeywords = eventKeywords.filter(kw => resultText.includes(kw));
    if (foundKeywords.length > 0) {
      score += 0.1 * Math.min(foundKeywords.length, 2); // Max 0.2 for keywords
      matched_keywords.push(...foundKeywords);
    }
    
    // Boost score if result has a date
    if (result.date) {
      score += 0.1;
      matched_keywords.push('has_date');
    }
    
    return {
      score: Math.min(score, 1), // Cap at 1.0
      matched_keywords
    };
  }

  /**
   * Extract date from search result snippet
   * @param {string} snippet - Result snippet
   * @returns {string|null} - Extracted date or null
   */
  extractDateFromSnippet(snippet) {
    if (!snippet) return null;

    // Simple date pattern matching (can be improved)
    const datePatterns = [
      /\b(\w+ \d{1,2},? \d{4})\b/i, // January 15, 2025
      /\b(\d{1,2} \w+ \d{4})\b/i,   // 15 January 2025
      /\b(\d{4}-\d{2}-\d{2})\b/     // 2025-01-15
    ];

    for (const pattern of datePatterns) {
      const match = snippet.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Extract location from search result snippet
   * @param {string} snippet - Result snippet
   * @returns {string|null} - Extracted location or null
   */
  extractLocationFromSnippet(snippet) {
    if (!snippet) return null;

    // Look for common location indicators
    const locationPatterns = [
      /at ([A-Z][a-zA-Z\s]+(?:Hall|Center|Centre|Stadium|Arena|Park))/i,
      /in ([A-Z][a-zA-Z\s]+(?:City|Town|District))/i,
      /near ([A-Z][a-zA-Z\s]+)/i
    ];

    for (const pattern of locationPatterns) {
      const match = snippet.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    return null;
  }

  /**
   * Check if Serp API is configured and working
   * @returns {Promise<Object>} - Health check result
   */
  async healthCheck() {
    try {
      logger.info('🏥 [SerpAPI] Starting health check');

      if (!this.apiKey) {
        logger.warn('⚠️ [SerpAPI] Health check failed - API key not configured');
        return {
          healthy: false,
          configured: false,
          message: 'SERP_API_KEY not configured in environment variables'
        };
      }

      logger.info('🔍 [SerpAPI] Testing API with simple search');

      // Try a simple search
      const response = await axios.get(this.apiBaseUrl, {
        params: {
          api_key: this.apiKey,
          q: 'test',
          engine: 'google',
          gl: 'my',
          hl: 'en',
          num: 1
        },
        timeout: 5000
      });

      logger.info('✅ [SerpAPI] Health check passed', {
        status: response.status,
        hasData: !!response.data
      });

      return {
        healthy: true,
        configured: true,
        status: response.status,
        message: 'Serp API is working correctly',
        test_search_results: response.data.search_information?.total_results || 0
      };

    } catch (error) {
      logger.error('❌ [SerpAPI] Health check failed', {
        error: error.message,
        status: error.response?.status
      });

      return {
        healthy: false,
        configured: true,
        error: error.message,
        message: 'Serp API call failed',
        status: error.response?.status || null
      };
    }
  }
}

module.exports = new SerpService();

