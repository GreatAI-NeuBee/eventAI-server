const axios = require('axios');
const winston = require('winston');
const eventService = require('./eventService');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'forecast-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

class ForecastService {
  constructor() {
    this.aiModelEndpoint = process.env.AI_MODEL_ENDPOINT || 'http://localhost:8080/predict';
    this.newModelEndpoint = process.env.FORECAST_MODEL_ENDPOINT || 'http://56.68.21.46/forecast_inout';
    this.modelTimeout = parseInt(process.env.MODEL_TIMEOUT) || 30000; // 30 seconds
  }

  /**
   * Generates crowd forecast for an event
   * @param {string} eventId - Event ID
   * @param {Object} inputData - Additional input data for forecasting
   * @returns {Promise<Object>} - Forecast result
   */
  async generateForecast(eventId, inputData = {}) {
    try {
      logger.info('Generating forecast for event', { eventId });

      // Get event details
      const event = await eventService.getEventById(eventId);
      if (!event) {
        throw new Error('Event not found');
      }

      // Prepare input data for AI model
      const modelInput = this.prepareModelInput(event, inputData);

      // Call AI model
      const forecastResult = await this.callAIModel(modelInput);

      // Update event with forecast result
      const updatedEvent = await eventService.updateEventForecast(eventId, forecastResult);

      logger.info('Forecast generated successfully', { eventId });

      return {
        eventId,
        forecastResult,
        generatedAt: new Date().toISOString(),
        modelEndpoint: this.aiModelEndpoint,
        inputData: modelInput
      };

    } catch (error) {
      logger.error('Error generating forecast', { eventId, error: error.message });
      throw new Error(`Failed to generate forecast: ${error.message}`);
    }
  }

  /**
   * Prepares input data for the AI model
   * @param {Object} event - Event details
   * @param {Object} additionalData - Additional input data
   * @returns {Object} - Formatted input for AI model
   */
  prepareModelInput(event, additionalData = {}) {
    const baseInput = {
      event_id: event.eventId,
      event_name: event.name,
      date_of_event: event.dateOfEvent,
      timestamp: new Date().toISOString()
    };

    // Merge with additional data provided
    const modelInput = {
      ...baseInput,
      ...additionalData
    };

    logger.info('Prepared model input', { eventId: event.eventId, inputKeys: Object.keys(modelInput) });
    return modelInput;
  }

  /**
   * Calls the AI model endpoint
   * @param {Object} inputData - Input data for the model
   * @returns {Promise<Object>} - Model prediction result
   */
  async callAIModel(inputData) {
    try {
      logger.info('Calling AI model', { endpoint: this.aiModelEndpoint });

      const response = await axios.post(this.aiModelEndpoint, inputData, {
        timeout: this.modelTimeout,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'EventAI-Server/1.0'
        }
      });

      if (response.status !== 200) {
        throw new Error(`AI model returned status ${response.status}`);
      }

      logger.info('AI model response received', { 
        status: response.status,
        dataSize: JSON.stringify(response.data).length 
      });

      return this.processModelResponse(response.data);

    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        logger.error('AI model endpoint unreachable', { endpoint: this.aiModelEndpoint });
        throw new Error('AI model service is unavailable');
      } else if (error.code === 'ENOTFOUND') {
        logger.error('AI model endpoint not found', { endpoint: this.aiModelEndpoint });
        throw new Error('AI model service endpoint not found');
      } else if (error.code === 'ETIMEDOUT') {
        logger.error('AI model request timeout', { timeout: this.modelTimeout });
        throw new Error('AI model request timed out');
      } else {
        logger.error('AI model call failed', { error: error.message });
        throw new Error(`AI model call failed: ${error.message}`);
      }
    }
  }

  /**
   * Processes and validates the AI model response
   * @param {Object} rawResponse - Raw response from AI model
   * @returns {Object} - Processed forecast result
   */
  processModelResponse(rawResponse) {
    try {
      // Expected AI model response format:
      // {
      //   "crowd_forecast": {
      //     "total_predicted_attendance": 5000,
      //     "peak_hours": ["14:00", "15:00", "16:00"],
      //     "hourly_distribution": {...},
      //     "zone_predictions": {...},
      //     "gate_predictions": {...},
      //     "confidence_score": 0.85
      //   },
      //   "risk_assessment": {
      //     "congestion_risk": "medium",
      //     "high_risk_zones": [...],
      //     "recommended_actions": [...]
      //   }
      // }

      const processedResult = {
        prediction: rawResponse,
        metadata: {
          processedAt: new Date().toISOString(),
          modelVersion: rawResponse.model_version || 'unknown',
          confidence: rawResponse.crowd_forecast?.confidence_score || null
        },
        summary: this.generateForecastSummary(rawResponse)
      };

      logger.info('Model response processed successfully');
      return processedResult;

    } catch (error) {
      logger.error('Error processing model response', { error: error.message });
      throw new Error(`Failed to process model response: ${error.message}`);
    }
  }

  /**
   * Generates a human-readable summary of the forecast
   * @param {Object} modelResponse - Raw model response
   * @returns {Object} - Summary object
   */
  generateForecastSummary(modelResponse) {
    try {
      const forecast = modelResponse.crowd_forecast || {};
      const risk = modelResponse.risk_assessment || {};

      return {
        totalAttendance: forecast.total_predicted_attendance || 0,
        peakHours: forecast.peak_hours || [],
        congestionRisk: risk.congestion_risk || 'unknown',
        highRiskZones: risk.high_risk_zones || [],
        recommendations: risk.recommended_actions || [],
        confidence: forecast.confidence_score || 0
      };
    } catch (error) {
      logger.warn('Error generating forecast summary', { error: error.message });
      return {
        totalAttendance: 0,
        peakHours: [],
        congestionRisk: 'unknown',
        highRiskZones: [],
        recommendations: [],
        confidence: 0
      };
    }
  }

  /**
   * Retrieves forecast for an event
   * @param {string} eventId - Event ID
   * @returns {Promise<Object|null>} - Forecast result or null if not found
   */
  async getForecast(eventId) {
    try {
      logger.info('Retrieving forecast for event', { eventId });

      const event = await eventService.getEventById(eventId);
      if (!event) {
        throw new Error('Event not found');
      }

      if (!event.forecastResult) {
        logger.info('No forecast available for event', { eventId });
        return null;
      }

      return {
        eventId,
        forecastResult: event.forecastResult,
        lastUpdated: event.updatedAt
      };

    } catch (error) {
      logger.error('Error retrieving forecast', { eventId, error: error.message });
      throw new Error(`Failed to retrieve forecast: ${error.message}`);
    }
  }

  /**
   * Deletes forecast for an event
   * @param {string} eventId - Event ID
   * @returns {Promise<void>}
   */
  async deleteForecast(eventId) {
    try {
      logger.info('Deleting forecast for event', { eventId });

      await eventService.updateEventForecast(eventId, null);

      logger.info('Forecast deleted successfully', { eventId });

    } catch (error) {
      logger.error('Error deleting forecast', { eventId, error: error.message });
      throw new Error(`Failed to delete forecast: ${error.message}`);
    }
  }

  /**
   * Validates forecast input data
   * @param {Object} inputData - Input data to validate
   * @returns {Object} - Validation result
   */
  validateForecastInput(inputData) {
    const errors = [];
    const warnings = [];

    // Required fields validation
    if (!inputData.event_id) {
      errors.push('event_id is required');
    }

    // Optional but recommended fields
    if (!inputData.historical_data) {
      warnings.push('historical_data not provided - may affect accuracy');
    }

    if (!inputData.weather_data) {
      warnings.push('weather_data not provided - may affect accuracy');
    }

    if (!inputData.promotional_data) {
      warnings.push('promotional_data not provided - may affect accuracy');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Generates crowd forecast for an event using the new model endpoint
   * @param {string} eventId - Event ID
   * @param {Object} forecastData - Forecast input data for new model
   * @returns {Promise<Object>} - Forecast result
   */
  async generateForecastWithNewModel(eventId, forecastData) {
    try {
      logger.info('Generating forecast using new model endpoint', { eventId });

      // Get event details
      const event = await eventService.getEventById(eventId);
      if (!event) {
        throw new Error('Event not found');
      }

      // Call new AI model endpoint
      const modelResponse = await this.callNewAIModel(forecastData);

      // Update event with forecast result
      const updatedEvent = await eventService.updateEventForecast(eventId, modelResponse);

      logger.info('Forecast generated successfully using new model', { eventId });

      return {
        eventId,
        forecastResult: modelResponse,
        generatedAt: new Date().toISOString(),
        modelEndpoint: this.newModelEndpoint,
        inputData: forecastData
      };

    } catch (error) {
      logger.error('Error generating forecast with new model', { eventId, error: error.message });
      throw new Error(`Failed to generate forecast: ${error.message}`);
    }
  }

  /**
   * Cleans datetime string by removing timezone information
   * @param {string} datetimeStr - Datetime string that may contain timezone
   * @returns {string} - Cleaned datetime string without timezone
   */
  cleanDatetimeString(datetimeStr) {
    if (!datetimeStr) return datetimeStr;
    
    // Remove timezone information from datetime strings
    // Examples:
    // "2025-09-21T14:00:00" -> "2025-09-21 14:00:00"
    // "2025-09-21T14:00:00+00:00" -> "2025-09-21 14:00:00"
    // "2025-09-21T14:00:00Z" -> "2025-09-21 14:00:00"
    
    let cleaned = datetimeStr.toString();
    
    // Remove timezone offset (+XX:XX, -XX:XX, Z)
    cleaned = cleaned.replace(/[+-]\d{2}:\d{2}$|Z$/, '');
    
    // Replace T with space for standard format
    cleaned = cleaned.replace('T', ' ');
    
    return cleaned;
  }

  /**
   * Calls the new AI model endpoint at http://43.216.25.126/forecast_inout
   * @param {Object} forecastData - Forecast input data
   * @returns {Promise<Object>} - Model prediction result
   */
  async callNewAIModel(forecastData) {
    try {
      // Clean datetime strings to remove timezone information
      const cleanedData = {
        ...forecastData,
        schedule_start_time: this.cleanDatetimeString(forecastData.schedule_start_time),
        event_end_time: this.cleanDatetimeString(forecastData.event_end_time)
      };

      logger.info('Calling new AI model', { 
        endpoint: this.newModelEndpoint,
        requestData: cleanedData
      });

      const response = await axios.post(this.newModelEndpoint, cleanedData, {
        timeout: this.modelTimeout,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'EventAI-Server/1.0'
        }
      });

      if (response.status !== 200) {
        logger.error('AI model returned non-200 status', { 
          status: response.status,
          statusText: response.statusText,
          data: response.data
        });
        throw new Error(`AI model returned status ${response.status}: ${response.statusText}`);
      }

      logger.info('New AI model response received', { 
        status: response.status,
        dataSize: JSON.stringify(response.data).length,
        hasArrivals: !!response.data?.arrivals,
        hasExits: !!response.data?.exits
      });

      return this.processNewModelResponse(response.data, forecastData.gates, forecastData.gates_crowd, 
        forecastData.schedule_start_time, forecastData.event_end_time);

    } catch (error) {
      if (error.response) {
        // The request was made and the server responded with a status code
        logger.error('New AI model returned error response', {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: error.response.headers
        });
        throw new Error(`AI model call failed: ${error.response.status} - ${error.response.statusText}`);
      } else if (error.request) {
        // The request was made but no response was received
        logger.error('New AI model request failed - no response', { 
          error: error.message,
          code: error.code
        });
        if (error.code === 'ECONNREFUSED') {
          throw new Error('AI model service is unavailable');
        } else if (error.code === 'ENOTFOUND') {
          throw new Error('AI model service endpoint not found');
        } else if (error.code === 'ETIMEDOUT') {
          throw new Error('AI model request timed out');
        } else {
          throw new Error(`AI model call failed: ${error.message}`);
        }
      } else {
        // Something happened in setting up the request
        logger.error('New AI model call setup failed', { error: error.message });
        throw new Error(`AI model call failed: ${error.message}`);
      }
    }
  }

  /**
   * Processes and validates the new AI model response
   * @param {Object} rawResponse - Raw response from new AI model
   * @param {Array} gates - Array of gate names
   * @param {Array} gatesCrowd - Array of gate capacities (required)
   * @param {string} scheduleStartTime - Requested start time
   * @param {string} eventEndTime - Requested end time
   * @returns {Object} - Processed forecast result
   */
  processNewModelResponse(rawResponse, gates, gatesCrowd, scheduleStartTime, eventEndTime) {
    try {
      logger.info('Processing new model response', {
        responseType: typeof rawResponse,
        hasArrivals: !!rawResponse?.arrivals,
        hasExits: !!rawResponse?.exits,
        arrivalsGates: rawResponse?.arrivals ? Object.keys(rawResponse.arrivals) : [],
        exitsGates: rawResponse?.exits ? Object.keys(rawResponse.exits) : []
      });

      // Extract and structure the forecast data properly
      const structuredForecast = this.structureForecastData(rawResponse, gates, gatesCrowd, scheduleStartTime, eventEndTime);

      const processedResult = {
        forecast: structuredForecast,
        metadata: {
          processedAt: new Date().toISOString(),
          modelVersion: rawResponse.model_version || 'forecast_inout_v1',
          endpoint: this.newModelEndpoint,
          totalGates: Object.keys(structuredForecast).length,
          timeFrameCount: Object.keys(structuredForecast).length > 0 ? 
            Object.values(structuredForecast)[0].timeFrames.length : 0
        },
        summary: this.generateNewModelForecastSummary(structuredForecast)
      };

      logger.info('New model response processed successfully', {
        resultKeys: Object.keys(processedResult),
        gateCount: Object.keys(structuredForecast).length,
        firstGateTimeFrames: Object.keys(structuredForecast).length > 0 ? 
          Object.values(structuredForecast)[0].timeFrames.length : 0
      });
      return processedResult;

    } catch (error) {
      logger.error('Error processing new model response', { 
        error: error.message,
        stack: error.stack,
        rawResponseType: typeof rawResponse
      });
      throw new Error(`Failed to process model response: ${error.message}`);
    }
  }

  /**
   * Structures the forecast data into the expected format
   * @param {Object} rawResponse - Raw response from AI model
   * @param {Array} gates - Array of gate names
   * @param {Array} gatesCrowd - Array of gate capacities (required)
   * @param {string} scheduleStartTime - Requested start time
   * @param {string} eventEndTime - Requested end time
   * @returns {Object} - Structured forecast data with gate names as keys
   */
  structureForecastData(rawResponse, gates, gatesCrowd, scheduleStartTime, eventEndTime) {
    try {
      const structuredData = {};

      // Extract gates from arrivals data (ignoring the exits data as requested)
      if (rawResponse.arrivals) {
        gates.forEach((gateId, index) => {
          const gateData = rawResponse.arrivals[gateId];
          
          if (Array.isArray(gateData)) {
            // Process all timeframes
            const allTimeFrames = gateData.map(timeFrame => ({
              timestamp: timeFrame.ds,
              predicted: Math.round(timeFrame.yhat || 0),
              lower_bound: Math.round(timeFrame.yhat_lower || 0),
              upper_bound: Math.round(timeFrame.yhat_upper || 0)
            }));

            // Filter timeframes to match the requested time range if provided
            let filteredTimeFrames = allTimeFrames;
            if (scheduleStartTime && eventEndTime) {
              const startTime = this.cleanDatetimeString(scheduleStartTime);
              const endTime = this.cleanDatetimeString(eventEndTime);
              
              // Convert to Date objects for proper comparison (use local time parsing)
              const startDate = new Date(startTime.replace(' ', 'T'));
              const endDate = new Date(endTime.replace(' ', 'T'));
              
              // Get exits data for this gate if available
              const exitsData = rawResponse.exits && rawResponse.exits[gateId] ? 
                rawResponse.exits[gateId].map(item => ({
                  timestamp: item.ds,
                  predicted: Math.round(Math.max(0, item.yhat)),
                  lower_bound: Math.round(Math.max(0, item.yhat_lower)),
                  upper_bound: Math.round(Math.max(0, item.yhat_upper))
                })) : [];

              // Create maps of ALL AI model data (not filtered by requested range)
              const arrivalsMap = new Map();
              allTimeFrames.forEach(tf => {
                arrivalsMap.set(tf.timestamp, { ...tf, dataSource: 'arrivals' });
              });
              
              const exitsMap = new Map();
              exitsData.forEach(tf => {
                exitsMap.set(tf.timestamp, { ...tf, dataSource: 'exits' });
              });
              
              // Determine the full range (earliest arrivals to latest exits)
              const allTimestamps = [
                ...allTimeFrames.map(tf => tf.timestamp),
                ...exitsData.map(tf => tf.timestamp)
              ].sort();
              
              const fullStartTime = allTimestamps.length > 0 ? allTimestamps[0] : startTime;
              const fullEndTime = allTimestamps.length > 0 ? allTimestamps[allTimestamps.length - 1] : endTime;
              
              const fullStartDate = new Date(fullStartTime.replace(' ', 'T'));
              const fullEndDate = new Date(fullEndTime.replace(' ', 'T'));
              
              // Generate complete timeframe coverage for the FULL range (including all AI model data)
              const completeTimeFrames = [];
              let currentTime = new Date(fullStartDate);
              
              while (currentTime <= fullEndDate) {
                // Format time string to match the format used by the AI model
                const year = currentTime.getFullYear();
                const month = String(currentTime.getMonth() + 1).padStart(2, '0');
                const day = String(currentTime.getDate()).padStart(2, '0');
                const hours = String(currentTime.getHours()).padStart(2, '0');
                const minutes = String(currentTime.getMinutes()).padStart(2, '0');
                const seconds = String(currentTime.getSeconds()).padStart(2, '0');
                const timeString = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
                
                let timeFrame;
                if (arrivalsMap.has(timeString)) {
                  // Use arrivals data if available
                  timeFrame = arrivalsMap.get(timeString);
                } else if (exitsMap.has(timeString)) {
                  // Use exits data if available
                  timeFrame = exitsMap.get(timeString);
                } else {
                  // Fill gap with simulation data (predicted = 10)
                  timeFrame = {
                    timestamp: timeString,
                    predicted: 10,
                    lower_bound: 10,
                    upper_bound: 10,
                    dataSource: 'simulation'
                  };
                }
                
                completeTimeFrames.push(timeFrame);
                
                // Move to next 5-minute interval
                currentTime.setMinutes(currentTime.getMinutes() + 5);
              }
              
              filteredTimeFrames = completeTimeFrames;
              
              // Count data sources in the complete timeframes
              const arrivalsUsed = filteredTimeFrames.filter(tf => tf.dataSource === 'arrivals').length;
              const exitsUsed = filteredTimeFrames.filter(tf => tf.dataSource === 'exits').length;
              const simulationUsed = filteredTimeFrames.filter(tf => tf.dataSource === 'simulation').length;
              
              // Log complete timeframe generation results
              logger.info(`Complete timeframe generation for gate ${gateId}`, {
                totalArrivalsAvailable: allTimeFrames.length,
                totalExitsAvailable: exitsData.length,
                arrivalsUsed: arrivalsUsed,
                exitsUsed: exitsUsed,
                simulationGenerated: simulationUsed,
                totalTimeFrames: filteredTimeFrames.length,
                requestedRange: `${startTime} to ${endTime}`,
                actualFullRange: `${fullStartTime} to ${fullEndTime}`,
                arrivalsRange: allTimeFrames.length > 0 ? 
                  `${allTimeFrames[0].timestamp} to ${allTimeFrames[allTimeFrames.length-1].timestamp}` : 'none',
                exitsRange: exitsData.length > 0 ? 
                  `${exitsData[0].timestamp} to ${exitsData[exitsData.length-1].timestamp}` : 'none'
              });
              
              // Data source information is already set during timeframe generation
            }

            structuredData[gateId] = {
              capacity: gatesCrowd && gatesCrowd[index] ? gatesCrowd[index] : null,
              timeFrames: filteredTimeFrames
            };
          } else {
            // If no data for this gate, create empty structure
            structuredData[gateId] = {
              capacity: gatesCrowd && gatesCrowd[index] ? gatesCrowd[index] : null,
              timeFrames: []
            };
          }
        });
      }

      logger.info('Forecast data structured successfully', {
        gateCount: Object.keys(structuredData).length,
        gates: Object.keys(structuredData),
        timeFramesPerGate: Object.values(structuredData).map(g => g.timeFrames.length)
      });

      return structuredData;

    } catch (error) {
      logger.error('Error structuring forecast data', { error: error.message });
      throw new Error(`Failed to structure forecast data: ${error.message}`);
    }
  }

  /**
   * Generates a human-readable summary of the forecast from new model
   * @param {Object} structuredForecast - Structured forecast data (object with gate names as keys)
   * @returns {Object} - Summary object
   */
  generateNewModelForecastSummary(structuredForecast) {
    try {
      const gateNames = Object.keys(structuredForecast);
      const firstGateData = gateNames.length > 0 ? structuredForecast[gateNames[0]] : null;
      
      const summary = {
        totalGates: gateNames.length,
        gates: gateNames,
        forecastPeriod: {
          start: firstGateData && firstGateData.timeFrames.length > 0 
            ? firstGateData.timeFrames[0].timestamp 
            : null,
          end: firstGateData && firstGateData.timeFrames.length > 0 
            ? firstGateData.timeFrames[firstGateData.timeFrames.length - 1].timestamp 
            : null
        },
        predictions: gateNames.map(gateName => {
          const gateData = structuredForecast[gateName];
          
          // Count data sources if available
          const arrivalsFrames = gateData.timeFrames.filter(tf => tf.dataSource === 'arrivals').length;
          const exitsFrames = gateData.timeFrames.filter(tf => tf.dataSource === 'exits').length;
          const simulationFrames = gateData.timeFrames.filter(tf => tf.dataSource === 'simulation').length;
          
          return {
            gate: gateName,
            capacity: gateData.capacity,
            totalTimeFrames: gateData.timeFrames.length,
            peakPrediction: gateData.timeFrames.length > 0 ? 
              Math.max(...gateData.timeFrames.map(tf => tf.predicted)) : 0,
            avgPrediction: gateData.timeFrames.length > 0 ?
              Math.round(gateData.timeFrames.reduce((sum, tf) => sum + tf.predicted, 0) / gateData.timeFrames.length) : 0,
            dataSources: {
              arrivals: arrivalsFrames,
              exits: exitsFrames,
              simulation: simulationFrames
            }
          };
        }),
        processedAt: new Date().toISOString(),
        status: 'completed'
      };

      return summary;
    } catch (error) {
      logger.warn('Error generating new model forecast summary', { error: error.message });
      return {
        totalGates: 0,
        gates: [],
        forecastPeriod: { start: null, end: null },
        predictions: [],
        processedAt: new Date().toISOString(),
        status: 'error',
        error: error.message
      };
    }
  }

  /**
   * Test AI model connectivity
   * @returns {Promise<boolean>} - Connection status
   */
  async testModelConnection() {
    try {
      const testData = {
        test: true,
        timestamp: new Date().toISOString()
      };

      const response = await axios.post(`${this.aiModelEndpoint}/health`, testData, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      logger.info('AI model health check successful', { status: response.status });
      return true;

    } catch (error) {
      logger.error('AI model health check failed', { error: error.message });
      return false;
    }
  }

  /**
   * Test new AI model connectivity
   * @returns {Promise<boolean>} - Connection status
   */
  async testNewModelConnection() {
    try {
      // Simple health check for the new model endpoint
      const testData = {
        gates: ["test"],
        schedule_start_time: "2025-09-21 14:00:00",
        event_end_time: "2025-09-21 16:00:00",
        method_exits: "test",
        freq: "5min"
      };

      const response = await axios.post(this.newModelEndpoint, testData, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      logger.info('New AI model health check successful', { status: response.status });
      return true;

    } catch (error) {
      logger.error('New AI model health check failed', { error: error.message });
      return false;
    }
  }
}

module.exports = new ForecastService();
