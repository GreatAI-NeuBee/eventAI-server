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
}

module.exports = new ForecastService();
