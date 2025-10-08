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
  defaultMeta: { service: 'prediction-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

class PredictionService {
  constructor() {
    this.modelEndpoint = process.env.PREDICTION_MODEL_ENDPOINT || 'http://56.68.30.73/predict';
    this.timeout = parseInt(process.env.PREDICTION_TIMEOUT) || 30000; // 30 seconds default
  }

  /**
   * Calls the prediction model API to get real-time predictions
   * @param {Object} event - Event object with forecast_result
   * @returns {Promise<Object>} - Prediction results
   */
  async getPrediction(event) {
    try {
      logger.info('Getting prediction for event', { 
        eventId: event.eventId,
        modelEndpoint: this.modelEndpoint 
      });

      // Check if event has forecast_result
      if (!event.forecastResult) {
        throw new Error('Event must have forecast_result before getting predictions');
      }

      // Transform forecast_result to gates_info format expected by the model
      const gatesInfo = this.transformForecastToGatesInfo(event.forecastResult, event);

      const requestBody = {
        gates_info: gatesInfo,
        forecast_minutes: 5 // Always predict 5 minutes ahead
      };

      logger.info('Calling prediction model', { 
        eventId: event.eventId,
        gatesCount: gatesInfo.length,
        requestBody: JSON.stringify(requestBody, null, 2)
      });

      const response = await axios.post(this.modelEndpoint, requestBody, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      const predictionResult = {
        predictions: response.data.predictions || [],
        metadata: {
          eventId: event.eventId,
          modelEndpoint: this.modelEndpoint,
          requestedAt: new Date().toISOString(),
          forecastMinutes: 5,
          gatesProcessed: gatesInfo.length
        },
        rawResponse: response.data
      };

      logger.info('Prediction completed successfully', { 
        eventId: event.eventId,
        predictionsCount: predictionResult.predictions.length,
        responseSize: JSON.stringify(response.data).length
      });

      return predictionResult;
    } catch (error) {
      logger.error('Error getting prediction', { 
        eventId: event?.eventId,
        error: error.message,
        endpoint: this.modelEndpoint
      });
      
      // Return error result instead of throwing
      return {
        error: true,
        message: error.message,
        eventId: event?.eventId,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Transforms forecast_result to the gates_info format expected by the prediction model
   * @param {Object} forecastResult - Forecast result from the event
   * @param {Object} event - Event object for additional context
   * @returns {Array} - Array of gates_info objects
   */
  transformForecastToGatesInfo(forecastResult, event) {
    try {
      // This transformation depends on your forecast_result structure
      // Based on typical forecast results, we'll extract gate information
      const gatesInfo = [];

      // Priority 1: Check forecast_result.summary.gates + forecast_result.forecast
      if (forecastResult.summary?.gates && Array.isArray(forecastResult.summary.gates) && forecastResult.forecast) {
        logger.info('Extracting gates from forecast_result.summary.gates and forecast', { 
          eventId: event.eventId,
          gateIds: forecastResult.summary.gates
        });
        
        forecastResult.summary.gates.forEach((gateId) => {
          const gateData = forecastResult.forecast[gateId];
          const gatePrediction = forecastResult.summary.predictions?.find(p => p.gate === gateId);
          
          // Get the latest timeframe data for historical count
          const latestTimeFrame = gateData?.timeFrames?.[gateData.timeFrames.length - 1];
          
          const gateInfo = {
            gate_id: gateId, // Use forecast gate ID directly (e.g., "1", "A", "B")
            zone: `Gate ${gateId}`,
            image_path: this.getDefaultImagePath('medium'), // Use default medium congestion image
            total_capacity: gateData?.capacity || gatePrediction?.capacity || 100,
            event_type: this.mapEventType(event.eventType || 'OTHER'),
            historical_count: latestTimeFrame?.predicted || gatePrediction?.avgPrediction || Math.floor(Math.random() * 50)
          };
          
          gatesInfo.push(gateInfo);
          
          logger.debug('Created gate_info for model', {
            gateId,
            gate_id: gateInfo.gate_id,
            capacity: gateInfo.total_capacity,
            hasGateData: !!gateData,
            hasTimeFrames: !!gateData?.timeFrames,
            timeFramesCount: gateData?.timeFrames?.length || 0
          });
        });
      }
      // Priority 2: Check forecast_result.gates array (old format)
      else if (forecastResult.gates && Array.isArray(forecastResult.gates)) {
        logger.info('Extracting gates from forecast_result.gates array', { 
          eventId: event.eventId 
        });
        
        forecastResult.gates.forEach((gate, index) => {
          gatesInfo.push({
            gate_id: gate.gate_id || gate.id || `gate_${index + 1}`,
            zone: gate.zone || gate.name || `Zone ${String.fromCharCode(65 + index)}`, // A, B, C, etc.
            image_path: gate.image_path || this.getDefaultImagePath('medium'),
            total_capacity: gate.capacity || gate.total_capacity || 100,
            event_type: this.mapEventType(event.eventType || 'OTHER'),
            historical_count: gate.current_count || gate.historical_count || Math.floor(Math.random() * 50)
          });
        });
      } 
      // Fallback: Create default gates
      else {
        // If no gates structure, create default gates based on event data
        logger.warn('No gates structure found in forecast_result, creating default gates', { 
          eventId: event.eventId 
        });
        
        // Create 3 default gates
        for (let i = 0; i < 3; i++) {
          gatesInfo.push({
            gate_id: `gate_${i + 1}`,
            zone: `Zone ${String.fromCharCode(65 + i)}`, // A, B, C
            image_path: this.getDefaultImagePath('medium'),
            total_capacity: 100,
            event_type: this.mapEventType(event.eventType || 'OTHER'),
            historical_count: Math.floor(Math.random() * 50) + 10 // Random between 10-60
          });
        }
      }

      logger.info('Transformed forecast to gates info', { 
        eventId: event.eventId,
        gatesCount: gatesInfo.length,
        gatesInfo: gatesInfo
      });

      return gatesInfo;
    } catch (error) {
      logger.error('Error transforming forecast to gates info', { 
        eventId: event?.eventId,
        error: error.message 
      });
      
      // Return minimal default structure
      return [{
        gate_id: 'gate_1',
        zone: 'Zone A',
        image_path: this.getDefaultImagePath('medium'),
        total_capacity: 100,
        event_type: 'concert',
        historical_count: 35
      }];
    }
  }

  /**
   * Maps event types to model-expected format
   * @param {string} eventType - Event type from database
   * @returns {string} - Model-compatible event type
   */
  mapEventType(eventType) {
    const typeMapping = {
      'CONCERT': 'concert',
      'CONFERENCE': 'conference',
      'SPORTS': 'sports',
      'FESTIVAL': 'festival',
      'OTHER': 'concert' // Default fallback
    };
    
    return typeMapping[eventType] || 'concert';
  }

  /**
   * Gets default image path for congestion level
   * @param {string} level - Congestion level (low, medium, high)
   * @returns {string} - Image URL
   */
  getDefaultImagePath(level = 'medium') {
    const imagePaths = {
      low: 'https://vkaongvemnzkvvvxgduk.supabase.co/storage/v1/object/public/congestion_image/low_congested.jpg',
      medium: 'https://vkaongvemnzkvvvxgduk.supabase.co/storage/v1/object/public/congestion_image/medium_congested.jpg',
      high: 'https://vkaongvemnzkvvvxgduk.supabase.co/storage/v1/object/public/congestion_image/high_congested.jpg'
    };
    
    return imagePaths[level] || imagePaths.medium;
  }

  /**
   * Checks if the prediction model endpoint is healthy
   * @returns {Promise<Object>} - Health check result
   */
  async healthCheck() {
    try {
      logger.info('Checking prediction model health', { endpoint: this.modelEndpoint });
      
      const response = await axios.get(`${this.modelEndpoint}/health`, {
        timeout: 5000
      });
      
      return {
        healthy: true,
        endpoint: this.modelEndpoint,
        status: response.status,
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      logger.warn('Prediction model health check failed', { 
        endpoint: this.modelEndpoint,
        error: error.message 
      });
      
      return {
        healthy: false,
        endpoint: this.modelEndpoint,
        error: error.message,
        checkedAt: new Date().toISOString()
      };
    }
  }
}

module.exports = new PredictionService();
