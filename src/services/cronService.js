const cron = require('node-cron');
const winston = require('winston');
const eventService = require('./eventService');
const predictionService = require('./predictionService');
const cctvService = require('./cctvService');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'cron-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

class CronService {
  constructor() {
    // Prediction cron job configuration
    this.predictionTask = null;
    this.isEnabled = process.env.ENABLE_PREDICTION_CRON === 'true';
    // Run at standard 5-minute intervals: :00, :05, :10, :15, :20, :25, :30, :35, :40, :45, :50, :55
    this.cronPattern = process.env.PREDICTION_CRON_PATTERN || '0,5,10,15,20,25,30,35,40,45,50,55 * * * *';
    
    // CCTV snapshot cron job configuration
    this.cctvTask = null;
    this.cctvEnabled = process.env.ENABLE_CCTV_CRON === 'true';
    // Run every 3 minutes: */3 * * * *
    this.cctvCronPattern = process.env.CCTV_CRON_PATTERN || '*/3 * * * *';
    
    logger.info('CronService initialized', { 
      predictionEnabled: this.isEnabled,
      predictionPattern: this.cronPattern,
      predictionDescription: 'Runs at standard 5-minute intervals (:00, :05, :10, :15, :20, :25, :30, :35, :40, :45, :50, :55)',
      cctvEnabled: this.cctvEnabled,
      cctvPattern: this.cctvCronPattern,
      cctvDescription: 'Runs every 3 minutes'
    });
  }

  /**
   * Starts the prediction cron job
   */
  start() {
    if (!this.isEnabled) {
      logger.info('Prediction cron job is disabled via environment variable');
      return;
    }

    if (this.predictionTask) {
      logger.warn('Prediction cron job is already running');
      return;
    }

    logger.info('Starting prediction cron job', { pattern: this.cronPattern });

    this.predictionTask = cron.schedule(this.cronPattern, async () => {
      await this.runPredictionUpdate();
    }, {
      scheduled: true,
      timezone: process.env.TZ || 'UTC'
    });

    logger.info('Prediction cron job started successfully');
  }

  /**
   * Starts the CCTV snapshot cron job
   */
  startCCTV() {
    if (!this.cctvEnabled) {
      logger.info('CCTV snapshot cron job is disabled via environment variable');
      return;
    }

    if (this.cctvTask) {
      logger.warn('CCTV snapshot cron job is already running');
      return;
    }

    logger.info('Starting CCTV snapshot cron job', { pattern: this.cctvCronPattern });

    this.cctvTask = cron.schedule(this.cctvCronPattern, async () => {
      await this.runCCTVSnapshot();
    }, {
      scheduled: true,
      timezone: process.env.TZ || 'UTC'
    });

    logger.info('CCTV snapshot cron job started successfully');
  }

  /**
   * Stops the prediction cron job
   */
  stop() {
    if (this.predictionTask) {
      this.predictionTask.stop();
      this.predictionTask = null;
      logger.info('Prediction cron job stopped');
    } else {
      logger.info('No prediction cron job to stop');
    }
  }

  /**
   * Stops the CCTV snapshot cron job
   */
  stopCCTV() {
    if (this.cctvTask) {
      this.cctvTask.stop();
      this.cctvTask = null;
      logger.info('CCTV snapshot cron job stopped');
    } else {
      logger.info('No CCTV snapshot cron job to stop');
    }
  }

  /**
   * Restarts the prediction cron job
   */
  restart() {
    logger.info('Restarting prediction cron job');
    this.stop();
    
    // Re-read environment variables
    this.isEnabled = process.env.ENABLE_PREDICTION_CRON === 'true';
    this.cronPattern = process.env.PREDICTION_CRON_PATTERN || '*/5 * * * *';
    
    this.start();
  }

  /**
   * Gets the status of the cron job
   */
  getStatus() {
    return {
      isEnabled: this.isEnabled,
      isRunning: !!this.predictionTask,
      cronPattern: this.cronPattern,
      timezone: process.env.TZ || 'UTC',
      lastRun: this.lastRunTime || null,
      nextRun: this.predictionTask ? 'Every 5 minutes' : null
    };
  }

  /**
   * Runs the prediction update for ongoing events
   */
  async runPredictionUpdate() {
    const startTime = new Date();
    this.lastRunTime = startTime.toISOString();
    
    logger.info('Starting prediction update cron job');

    try {
      // Get ongoing events (events that are currently happening)
      const ongoingEvents = await this.getOngoingEvents();
      
      if (ongoingEvents.length === 0) {
        logger.info('No ongoing events found for prediction update');
        return;
      }

      logger.info('Found ongoing events for prediction update', { 
        count: ongoingEvents.length,
        eventIds: ongoingEvents.map(e => e.eventId)
      });

      // Process each ongoing event
      const results = await Promise.allSettled(
        ongoingEvents.map(event => this.updateEventPrediction(event))
      );

      // Log results
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      logger.info('Prediction update cron job completed', {
        totalEvents: ongoingEvents.length,
        successful,
        failed,
        duration: Date.now() - startTime.getTime()
      });

      // Log failed events
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.error('Failed to update prediction for event', {
            eventId: ongoingEvents[index].eventId,
            error: result.reason?.message || result.reason
          });
        }
      });

    } catch (error) {
      logger.error('Error in prediction update cron job', { 
        error: error.message,
        duration: Date.now() - startTime.getTime()
      });
    }
  }

  /**
   * Gets events that are happening today (events scheduled for today)
   */
  async getOngoingEvents() {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      
      logger.info('Getting events for today', { 
        todayStart: todayStart.toISOString(),
        todayEnd: todayEnd.toISOString(),
        currentTime: now.toISOString()
      });
      
      // Get all events (no status filter since status management isn't implemented yet)
      const { events } = await eventService.getEvents(1000, 0, {});

      // Filter for events happening today with forecast results
      const todaysEvents = events.filter(event => {
        const eventStart = new Date(event.dateOfEventStart);
        const eventEnd = new Date(event.dateOfEventEnd);
        
        // Check if event is scheduled for today (event start date is today)
        const eventStartDate = new Date(eventStart.getFullYear(), eventStart.getMonth(), eventStart.getDate());
        const todayDate = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate());
        
        const isToday = eventStartDate.getTime() === todayDate.getTime();
        const hasForecast = !!event.forecastResult;
        
        // Use forecast period if available, otherwise use event times
        let forecastStart = eventStart;
        let forecastEnd = eventEnd;
        
        if (event.forecastResult?.summary?.forecastPeriod) {
          const period = event.forecastResult.summary.forecastPeriod;
          if (period.start) {
            // Forecast period timestamps are in format "YYYY-MM-DD HH:mm:ss" without timezone
            // They represent UTC time, so we need to explicitly parse as UTC
            forecastStart = this.parseAsUTC(period.start);
          }
          if (period.end) {
            forecastEnd = this.parseAsUTC(period.end);
          }
        }
        
        // Check if current time is within forecast period
        // Allow prediction to start 1 hour before event starts
        const ONE_HOUR_MS = 60 * 60 * 1000;
        const oneHourBeforeStart = new Date(forecastStart.getTime() - ONE_HOUR_MS);
        
        const isWithinPreStartWindow = now >= oneHourBeforeStart; // 1 hour before start
        const hasNotEnded = now <= forecastEnd;
        const isOngoing = isWithinPreStartWindow && hasNotEnded;

        logger.debug('Event filter check', {
          eventId: event.eventId,
          eventStart: eventStart.toISOString(),
          eventEnd: eventEnd.toISOString(),
          forecastStart: forecastStart.toISOString(),
          forecastEnd: forecastEnd.toISOString(),
          oneHourBeforeStart: oneHourBeforeStart.toISOString(),
          currentTime: now.toISOString(),
          isToday,
          hasForecast,
          isWithinPreStartWindow,
          hasNotEnded,
          isOngoing,
          included: isToday && hasForecast && isOngoing
        });

        return isToday && hasForecast && isOngoing;
      });

      logger.info('Filtered events for today', { 
        totalEvents: events.length,
        todaysEvents: todaysEvents.length,
        eventIds: todaysEvents.map(e => ({
          eventId: e.eventId,
          name: e.name,
          startTime: e.dateOfEventStart,
          endTime: e.dateOfEventEnd
        }))
      });

      return todaysEvents;
    } catch (error) {
      logger.error('Error getting today\'s events', { error: error.message });
      return [];
    }
  }

  /**
   * Updates prediction for a single event
   */
  async updateEventPrediction(event) {
    try {
      logger.info('Updating prediction for event', { eventId: event.eventId });

      // Get prediction from the model
      const predictionResult = await predictionService.getPrediction(event);

      // Check if prediction failed
      if (predictionResult.error) {
        throw new Error(`Prediction failed: ${predictionResult.message}`);
      }

      // Merge new predictions with existing predict_result
      const updatedPredictResult = this.mergePredictions(
        event.predictResult,
        predictionResult,
        event
      );

      // Update event with merged prediction result
      await eventService.updateEvent(event.eventId, {
        predictResult: updatedPredictResult
      });

      logger.info('Successfully updated prediction for event', { 
        eventId: event.eventId,
        predictionsCount: predictionResult.predictions?.length || 0,
        totalTimeFrames: this.countTotalTimeFrames(updatedPredictResult)
      });

      return {
        eventId: event.eventId,
        success: true,
        predictionsCount: predictionResult.predictions?.length || 0
      };

    } catch (error) {
      logger.error('Error updating prediction for event', { 
        eventId: event.eventId,
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Merges new predictions with existing predict_result
   * Appends new timeframes instead of replacing
   * @param {Object} existingPredictResult - Existing predict_result
   * @param {Object} newPredictionResult - New prediction from model
   * @param {Object} event - Event object (to get correct capacities from forecast_result)
   */
  mergePredictions(existingPredictResult, newPredictionResult, event) {
    // Initialize with existing structure or create new
    const merged = existingPredictResult ? JSON.parse(JSON.stringify(existingPredictResult)) : {};

    // Get forecast gate list and capacities
    const forecastGates = this.getForecastGateList(event.forecastResult);
    const gateCapacities = this.extractGateCapacitiesFromForecast(event.forecastResult);

    // Create reverse mapping: prediction gate_id -> forecast gate ID
    const predictionToForecastMap = this.createPredictionToForecastMapping(forecastGates);

    logger.info('Initializing predict_result for all forecast gates', {
      forecastGates,
      gateCapacities
    });

    // ✅ STEP 1: Initialize ALL forecast gates with their capacities from forecast_result.summary.predictions
    forecastGates.forEach(forecastGateId => {
      if (!merged[forecastGateId]) {
        // Get capacity from forecast_result.summary.predictions (most reliable source)
        let capacity = 100; // default
        
        if (event.forecastResult?.summary?.predictions) {
          const summaryPred = event.forecastResult.summary.predictions.find(p => p.gate === forecastGateId);
          if (summaryPred && summaryPred.capacity) {
            capacity = summaryPred.capacity;
          }
        }
        
        // Fallback: try forecast object
        if (capacity === 100 && event.forecastResult?.forecast?.[forecastGateId]?.capacity) {
          capacity = event.forecastResult.forecast[forecastGateId].capacity;
        }
        
        merged[forecastGateId] = {
          capacity,
          timeFrames: []
        };
        
        logger.info('Initialized gate in predict_result', { forecastGateId, capacity });
      }
    });

    // ✅ STEP 2: Add prediction data if model returned any
    const predictions = newPredictionResult.predictions || [];
    const timestamp = newPredictionResult.metadata?.requestedAt || new Date().toISOString();

    if (predictions.length === 0) {
      logger.warn('No predictions from model, returning initialized gates with existing data');
      return merged;
    }

    logger.info('Processing model predictions', {
      predictionsCount: predictions.length,
      modelGateIds: predictions.map(p => p.gate_id),
      predictionToForecastMap,
      forecastGates
    });

    // Process each prediction from model
    predictions.forEach(prediction => {
      const modelGateId = prediction.gate_id;
      
      // Map model gate_id to forecast gate ID
      const forecastGateId = predictionToForecastMap[modelGateId];
      
      if (!forecastGateId) {
        logger.warn('Skipping prediction for unknown gate', {
          modelGateId,
          forecastGates,
          availableMapping: predictionToForecastMap
        });
        return; // Skip gates not in forecast
      }

      // ✅ Extract values from correct model response fields
      const predicted = prediction.forecast_next_5_min?.predicted_people_count ?? 0;
      const actual = prediction.current_people_count ?? 0;
      const riskScore = prediction.forecast_next_5_min?.risk_score ?? null;
      const possibleIncidents = prediction.forecast_next_5_min?.possible_incidents ?? [];

      // Create new timeframe entry
      const newTimeFrame = {
        predicted,
        actual,
        timestamp: this.formatTimestamp(timestamp),
        dataSource: 'ai_model',
        riskScore,
        possibleIncidents
      };

      // Append to timeFrames array (don't replace!)
      merged[forecastGateId].timeFrames.push(newTimeFrame);

      logger.debug('Appended prediction timeframe', {
        modelGateId,
        forecastGateId,
        timestamp: newTimeFrame.timestamp,
        predicted: newTimeFrame.predicted,
        actual: newTimeFrame.actual,
        riskScore: newTimeFrame.riskScore,
        incidentsCount: newTimeFrame.possibleIncidents.length,
        capacity: merged[forecastGateId].capacity,
        totalTimeFrames: merged[forecastGateId].timeFrames.length
      });
    });

    return merged;
  }

  /**
   * Gets list of gates from forecast_result
   * @param {Object} forecastResult - Forecast result object
   * @returns {Array} - Array of gate IDs from forecast
   */
  getForecastGateList(forecastResult) {
    if (!forecastResult) {
      // No forecast_result: return default gate IDs
      logger.warn('No forecast_result provided, using default gates');
      return ['gate_1', 'gate_2', 'gate_3'];
    }
    
    // Try summary.gates first (most reliable)
    if (forecastResult.summary?.gates && forecastResult.summary.gates.length > 0) {
      return forecastResult.summary.gates;
    }
    
    // Fallback: extract from forecast object keys
    if (forecastResult.forecast && Object.keys(forecastResult.forecast).length > 0) {
      return Object.keys(forecastResult.forecast);
    }
    
    // If forecast_result exists but has no gates structure, use default
    logger.warn('Forecast_result has no gates structure, using default gates');
    return ['gate_1', 'gate_2', 'gate_3'];
  }

  /**
   * Creates reverse mapping from prediction gate IDs to forecast gate IDs
   * @param {Array} forecastGates - Array of gate IDs from forecast (e.g., ["1", "A", "B"])
   * @returns {Object} - Map of prediction gate_id to forecast gate ID
   */
  createPredictionToForecastMapping(forecastGates) {
    const mapping = {};
    
    forecastGates.forEach(forecastGateId => {
      // Get all possible prediction formats for this forecast gate
      const predictionIds = this.mapForecastGateIdToPredictionIds(forecastGateId);
      
      // Map each prediction ID back to the forecast gate ID
      predictionIds.forEach(predictionId => {
        mapping[predictionId] = forecastGateId;
      });
    });
    
    return mapping;
  }

  /**
   * Extracts gate capacities from forecast_result
   * Maps gate IDs from forecast format to prediction format
   * @param {Object} forecastResult - Forecast result object
   * @returns {Object} - Map of gate_id to capacity
   */
  extractGateCapacitiesFromForecast(forecastResult) {
    const capacities = {};
    
    if (!forecastResult) {
      logger.debug('No forecast_result, capacities will use model defaults');
      return capacities;
    }

    // Check forecast_result.summary.predictions for capacity
    if (forecastResult.summary?.predictions && forecastResult.summary.predictions.length > 0) {
      forecastResult.summary.predictions.forEach(pred => {
        if (pred.gate && pred.capacity) {
          const gateId = pred.gate;
          
          // Map forecast gate IDs to prediction gate IDs
          // forecast: "1", "2", "A", "B" 
          // prediction: "gate_1", "gate_2", "gate_3", etc.
          const mappedIds = this.mapForecastGateIdToPredictionIds(gateId);
          
          // Store capacity for all mapped IDs
          mappedIds.forEach(id => {
            capacities[id] = pred.capacity;
          });
        }
      });
    }

    // Check forecast_result.forecast for capacity (alternative structure)
    if (forecastResult.forecast && Object.keys(forecastResult.forecast).length > 0) {
      Object.keys(forecastResult.forecast).forEach(gateId => {
        const gateData = forecastResult.forecast[gateId];
        if (gateData.capacity) {
          // Map and store capacity
          const mappedIds = this.mapForecastGateIdToPredictionIds(gateId);
          mappedIds.forEach(id => {
            capacities[id] = gateData.capacity;
          });
        }
      });
    }

    // If no capacities found, it means forecast_result has no proper structure
    // Capacities will be taken from model response (prediction.total_capacity)
    if (Object.keys(capacities).length === 0) {
      logger.debug('No capacities found in forecast_result, will use model defaults');
    }

    logger.debug('Extracted gate capacities from forecast', { capacities, capacityCount: Object.keys(capacities).length });

    return capacities;
  }

  /**
   * Maps forecast gate IDs to prediction gate IDs
   * Handles different naming conventions between forecast and prediction
   * @param {String} forecastGateId - Gate ID from forecast (e.g., "1", "A")
   * @returns {Array} - Array of possible prediction gate IDs
   */
  mapForecastGateIdToPredictionIds(forecastGateId) {
    const mappedIds = [];
    
    // Always include the original ID
    mappedIds.push(forecastGateId);
    
    // Map numeric IDs: "1" -> "gate_1"
    if (/^\d+$/.test(forecastGateId)) {
      mappedIds.push(`gate_${forecastGateId}`);
    }
    
    // Map letter IDs: "A" -> "gate_3", "gate_A"
    // A=1st gate (sometimes gate_3), B=2nd gate (gate_4), etc.
    if (/^[A-Z]$/.test(forecastGateId)) {
      mappedIds.push(`gate_${forecastGateId}`);
      
      // Also map to numeric: A->gate_3, B->gate_4 (common pattern)
      const letterIndex = forecastGateId.charCodeAt(0) - 'A'.charCodeAt(0);
      mappedIds.push(`gate_${letterIndex + 3}`); // A=gate_3, B=gate_4, C=gate_5
    }
    
    // Map with "gate_" prefix: "gate_1" -> stays as is
    if (forecastGateId.startsWith('gate_')) {
      // Already in prediction format, keep as is
      // (already added as original ID)
    }
    
    return mappedIds;
  }

  /**
   * Formats timestamp to match forecast_result format
   */
  formatTimestamp(isoTimestamp) {
    const date = new Date(isoTimestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * Parses a timestamp string from forecast_result
   * Forecast timestamps are in format "YYYY-MM-DD HH:mm:ss" without timezone info
   * They represent Malaysia local time (UTC+8) and need to be converted to UTC
   * @param {String} timestamp - Timestamp string in format "YYYY-MM-DD HH:mm:ss"
   * @returns {Date} - Date object in UTC
   */
  parseAsUTC(timestamp) {
    if (!timestamp) return new Date();
    
    // If timestamp already has timezone info (Z or +00:00), parse normally
    if (timestamp.includes('Z') || timestamp.includes('+') || timestamp.includes('-')) {
      return new Date(timestamp);
    }
    
    // For "YYYY-MM-DD HH:mm:ss" format without timezone
    // Treat as Malaysia time (UTC+8) and convert to UTC by subtracting 8 hours
    const match = timestamp.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (match) {
      const [, year, month, day, hour, minute, second] = match;
      const MALAYSIA_OFFSET_HOURS = 8;
      return new Date(Date.UTC(
        parseInt(year),
        parseInt(month) - 1, // Month is 0-indexed
        parseInt(day),
        parseInt(hour) - MALAYSIA_OFFSET_HOURS, // Convert Malaysia time to UTC
        parseInt(minute),
        parseInt(second)
      ));
    }
    
    // Fallback: try appending 'Z' (may not work correctly in all timezones)
    logger.warn('parseAsUTC: Unable to parse timestamp with regex, falling back', { timestamp });
    const isoFormat = timestamp.replace(' ', 'T') + 'Z';
    return new Date(isoFormat);
  }

  /**
   * Counts total timeframes across all gates
   */
  countTotalTimeFrames(predictResult) {
    if (!predictResult) return 0;
    
    let total = 0;
    Object.keys(predictResult).forEach(gateId => {
      if (predictResult[gateId]?.timeFrames) {
        total += predictResult[gateId].timeFrames.length;
      }
    });
    
    return total;
  }

  /**
   * Runs CCTV snapshot capture and upload for all ongoing events
   * Called by the CCTV cron job
   */
  async runCCTVSnapshot() {
    const startTime = Date.now();
    
    try {
      logger.info('CCTV snapshot cron job started');

      // Process all ongoing events
      const result = await cctvService.processAllOngoingEvents();

      const duration = Date.now() - startTime;

      logger.info('CCTV snapshot cron job completed', {
        duration,
        totalEvents: result.totalEvents || 0,
        successful: result.successCount || 0,
        failed: result.failureCount || 0
      });

      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error('Error in CCTV snapshot cron job', {
        error: error.message,
        duration
      });

      return {
        success: false,
        error: error.message,
        duration
      };
    }
  }

  /**
   * Manually triggers a prediction update (for testing)
   */
  async triggerManualUpdate() {
    logger.info('Manually triggering prediction update');
    await this.runPredictionUpdate();
  }

  /**
   * Manually triggers a CCTV snapshot (for testing)
   */
  async triggerManualCCTVSnapshot() {
    logger.info('Manually triggering CCTV snapshot');
    await this.runCCTVSnapshot();
  }
}

module.exports = new CronService();
