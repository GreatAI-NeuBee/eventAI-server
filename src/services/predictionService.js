const axios = require('axios');
const winston = require('winston');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

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
    
    // S3 configuration for prediction images
    this.s3PredictionBucket = process.env.S3_PREDICTION_IMAGE_BUCKET || 'predict-model-images';
    this.s3PredictionPrefix = process.env.S3_PREDICTION_IMAGE_PREFIX || 'people_congested_image/test/images/';
    this.s3PredictionRegion = process.env.S3_PREDICTION_IMAGE_REGION || 'ap-southeast-5';
    this.s3PredictionBaseUrl = `https://${this.s3PredictionBucket}.s3.${this.s3PredictionRegion}.amazonaws.com/`;
    
    // Initialize S3 client for listing images
    this.s3Client = new S3Client({
      region: this.s3PredictionRegion,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });
    
    // Cache for S3 image URLs
    this.cachedImages = [];
    this.cacheTimestamp = null;
    this.cacheExpiryMinutes = 60; // Refresh cache every 60 minutes
    
    logger.info('PredictionService initialized', {
      modelEndpoint: this.modelEndpoint,
      s3Bucket: this.s3PredictionBucket,
      s3Prefix: this.s3PredictionPrefix,
      s3Region: this.s3PredictionRegion
    });
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
      const gatesInfo = await this.transformForecastToGatesInfo(event.forecastResult, event);

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
   * @returns {Promise<Array>} - Array of gates_info objects
   */
  async transformForecastToGatesInfo(forecastResult, event) {
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
        
        // Process all gates with Promise.all to fetch images in parallel
        const gatePromises = forecastResult.summary.gates.map(async (gateId, index) => {
          const gateData = forecastResult.forecast[gateId];
          const gatePrediction = forecastResult.summary.predictions?.find(p => p.gate === gateId);
          
          // Get the latest timeframe data for historical count
          const latestTimeFrame = gateData?.timeFrames?.[gateData.timeFrames.length - 1];
          
          // Get random image from S3 for each gate
          const imageUrl = await this.getImageForGate(index);
          
          const gateInfo = {
            gate_id: gateId, // Use forecast gate ID directly (e.g., "1", "A", "B")
            zone: `Gate ${gateId}`,
            image_path: imageUrl, // Random S3 image
            total_capacity: gateData?.capacity || gatePrediction?.capacity || 100,
            event_type: this.mapEventType(event.eventType || 'OTHER'),
            historical_count: latestTimeFrame?.predicted || gatePrediction?.avgPrediction || Math.floor(Math.random() * 50)
          };
          
          logger.debug('Created gate_info for model', {
            gateId,
            gate_id: gateInfo.gate_id,
            capacity: gateInfo.total_capacity,
            imageUrl,
            hasGateData: !!gateData,
            hasTimeFrames: !!gateData?.timeFrames,
            timeFramesCount: gateData?.timeFrames?.length || 0
          });
          
          return gateInfo;
        });
        
        const resolvedGates = await Promise.all(gatePromises);
        gatesInfo.push(...resolvedGates);
      }
      // Priority 2: Check forecast_result.gates array (old format)
      else if (forecastResult.gates && Array.isArray(forecastResult.gates)) {
        logger.info('Extracting gates from forecast_result.gates array', { 
          eventId: event.eventId 
        });
        
        const gatePromises = forecastResult.gates.map(async (gate, index) => {
          // Get random image from S3 for each gate
          const imageUrl = await this.getImageForGate(index);
          
          return {
            gate_id: gate.gate_id || gate.id || `gate_${index + 1}`,
            zone: gate.zone || gate.name || `Zone ${String.fromCharCode(65 + index)}`, // A, B, C, etc.
            image_path: gate.image_path || imageUrl,
            total_capacity: gate.capacity || gate.total_capacity || 100,
            event_type: this.mapEventType(event.eventType || 'OTHER'),
            historical_count: gate.current_count || gate.historical_count || Math.floor(Math.random() * 50)
          };
        });
        
        const resolvedGates = await Promise.all(gatePromises);
        gatesInfo.push(...resolvedGates);
      } 
      // Fallback: Create default gates
      else {
        // If no gates structure, create default gates based on event data
        logger.warn('No gates structure found in forecast_result, creating default gates', { 
          eventId: event.eventId 
        });
        
        // Create 3 default gates
        const defaultGatePromises = [];
        for (let i = 0; i < 3; i++) {
          defaultGatePromises.push(
            (async () => {
              const imageUrl = await this.getImageForGate(i);
              return {
                gate_id: `gate_${i + 1}`,
                zone: `Zone ${String.fromCharCode(65 + i)}`, // A, B, C
                image_path: imageUrl,
                total_capacity: 100,
                event_type: this.mapEventType(event.eventType || 'OTHER'),
                historical_count: Math.floor(Math.random() * 50) + 10 // Random between 10-60
              };
            })()
          );
        }
        
        const resolvedGates = await Promise.all(defaultGatePromises);
        gatesInfo.push(...resolvedGates);
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
      const fallbackImage = await this.getImageForGate(0);
      return [{
        gate_id: 'gate_1',
        zone: 'Zone A',
        image_path: fallbackImage,
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
   * Fetches list of images from S3 bucket and caches them
   * @returns {Promise<Array>} - Array of image URLs
   */
  async fetchImagesFromS3() {
    try {
      // Check if cache is still valid
      const now = Date.now();
      const cacheAgeMinutes = this.cacheTimestamp 
        ? (now - this.cacheTimestamp) / (1000 * 60) 
        : Infinity;
      
      if (this.cachedImages.length > 0 && cacheAgeMinutes < this.cacheExpiryMinutes) {
        logger.debug('Using cached S3 images', {
          cachedCount: this.cachedImages.length,
          cacheAgeMinutes: cacheAgeMinutes.toFixed(2)
        });
        return this.cachedImages;
      }

      logger.info('Fetching images from S3', {
        bucket: this.s3PredictionBucket,
        prefix: this.s3PredictionPrefix
      });

      const command = new ListObjectsV2Command({
        Bucket: this.s3PredictionBucket,
        Prefix: this.s3PredictionPrefix,
        MaxKeys: 1000 // Get up to 1000 images
      });

      const response = await this.s3Client.send(command);
      
      // Filter for image files (jpg, jpeg, png)
      const imageExtensions = ['.jpg', '.jpeg', '.png'];
      const imageObjects = (response.Contents || []).filter(obj => {
        const key = obj.Key.toLowerCase();
        return imageExtensions.some(ext => key.endsWith(ext));
      });

      // Build full URLs for each image
      this.cachedImages = imageObjects.map(obj => 
        `${this.s3PredictionBaseUrl}${obj.Key}`
      );

      this.cacheTimestamp = now;

      logger.info('S3 images fetched and cached', {
        totalObjects: response.Contents?.length || 0,
        imageCount: this.cachedImages.length,
        sampleImages: this.cachedImages.slice(0, 3)
      });

      return this.cachedImages;

    } catch (error) {
      logger.error('Error fetching images from S3', {
        error: error.message,
        bucket: this.s3PredictionBucket,
        prefix: this.s3PredictionPrefix
      });
      
      // Return empty array on error, will use fallback
      return [];
    }
  }

  /**
   * Gets a random image URL for prediction model
   * Fetches from S3 bucket with 400+ images
   * @returns {Promise<string>} - Random image URL from S3
   */
  async getRandomImageFromS3() {
    try {
      const images = await this.fetchImagesFromS3();
      
      if (images.length === 0) {
        logger.warn('No S3 images available, using default');
        return `${this.s3PredictionBaseUrl}${this.s3PredictionPrefix}example.png`;
      }

      // Select random image from the list
      const randomIndex = Math.floor(Math.random() * images.length);
      const selectedImage = images[randomIndex];
      
      logger.debug('Selected random S3 image', {
        randomIndex,
        totalImages: images.length,
        selectedImage
      });
      
      return selectedImage;

    } catch (error) {
      logger.error('Error getting random S3 image', { error: error.message });
      // Fallback to example image
      return `${this.s3PredictionBaseUrl}${this.s3PredictionPrefix}example.png`;
    }
  }

  /**
   * Gets image URL for a specific gate (uses random S3 images)
   * @param {number} gateIndex - Gate index (0-based)
   * @returns {Promise<string>} - Random image URL from S3
   */
  async getImageForGate(gateIndex) {
    // Each gate gets a different random image from S3
    const imageUrl = await this.getRandomImageFromS3();
    
    logger.debug('Selected image for gate', {
      gateIndex,
      imageUrl
    });
    
    return imageUrl;
  }

  /**
   * Gets a random image from S3 bucket
   * @returns {Promise<string>} - Random image URL
   */
  async getRandomImage() {
    return await this.getRandomImageFromS3();
  }

  /**
   * Gets all available images from S3
   * @returns {Promise<Array>} - Array of all image URLs from S3
   */
  async getAllCongestionImages() {
    return await this.fetchImagesFromS3();
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
