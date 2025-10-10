const cron = require('node-cron');
const winston = require('winston');
const eventService = require('./eventService');
const predictionService = require('./predictionService');
const pushNotificationService = require('./pushNotificationService');

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
    // Prediction cron job settings
    this.predictionTask = null;
    this.isEnabled = process.env.ENABLE_PREDICTION_CRON === 'true';
    // Run at standard 5-minute intervals: :00, :05, :10, :15, :20, :25, :30, :35, :40, :45, :50, :55
    this.cronPattern = process.env.PREDICTION_CRON_PATTERN || '0,5,10,15,20,25,30,35,40,45,50,55 * * * *';
    
    // Ongoing event notification cron job settings
    this.notificationTask = null;
    this.notificationEnabled = process.env.ENABLE_ONGOING_EVENT_NOTIFICATIONS === 'true';
    // Run every 10 minutes: :00, :10, :20, :30, :40, :50
    this.notificationPattern = process.env.ONGOING_EVENT_NOTIFICATION_PATTERN || '0,10,20,30,40,50 * * * *';
    
    // Track last notification times to prevent spam (eventId -> timestamp)
    this.lastNotificationTimes = new Map();
    
    logger.info('CronService initialized', { 
      predictionEnabled: this.isEnabled,
      predictionPattern: this.cronPattern,
      notificationEnabled: this.notificationEnabled,
      notificationPattern: this.notificationPattern,
      predictionDescription: 'Runs at standard 5-minute intervals (:00, :05, :10, :15, :20, :25, :30, :35, :40, :45, :50, :55)',
      notificationDescription: 'Runs every 10 minutes (:00, :10, :20, :30, :40, :50) to notify ongoing events'
    });
  }

  /**
   * Starts both cron jobs (prediction and ongoing event notifications)
   */
  start() {
    this.startPredictionCron();
    this.startOngoingEventNotificationCron();
  }

  /**
   * Starts the prediction cron job
   */
  startPredictionCron() {
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
   * Starts the ongoing event notification cron job
   */
  startOngoingEventNotificationCron() {
    if (!this.notificationEnabled) {
      logger.info('Ongoing event notification cron job is disabled via environment variable');
      return;
    }

    if (this.notificationTask) {
      logger.warn('Ongoing event notification cron job is already running');
      return;
    }

    logger.info('Starting ongoing event notification cron job', { pattern: this.notificationPattern });

    this.notificationTask = cron.schedule(this.notificationPattern, async () => {
      await this.runOngoingEventNotifications();
    }, {
      scheduled: true,
      timezone: process.env.TZ || 'UTC'
    });

    logger.info('Ongoing event notification cron job started successfully');
  }

  /**
   * Stops both cron jobs
   */
  stop() {
    this.stopPredictionCron();
    this.stopOngoingEventNotificationCron();
  }

  /**
   * Stops the prediction cron job
   */
  stopPredictionCron() {
    if (this.predictionTask) {
      this.predictionTask.stop();
      this.predictionTask = null;
      logger.info('Prediction cron job stopped');
    } else {
      logger.info('No prediction cron job to stop');
    }
  }

  /**
   * Stops the ongoing event notification cron job
   */
  stopOngoingEventNotificationCron() {
    if (this.notificationTask) {
      this.notificationTask.stop();
      this.notificationTask = null;
      logger.info('Ongoing event notification cron job stopped');
    } else {
      logger.info('No ongoing event notification cron job to stop');
    }
  }

  /**
   * Restarts both cron jobs
   */
  restart() {
    logger.info('Restarting all cron jobs');
    this.stop();
    
    // Re-read environment variables
    this.isEnabled = process.env.ENABLE_PREDICTION_CRON === 'true';
    this.cronPattern = process.env.PREDICTION_CRON_PATTERN || '0,5,10,15,20,25,30,35,40,45,50,55 * * * *';
    this.notificationEnabled = process.env.ENABLE_ONGOING_EVENT_NOTIFICATIONS === 'true';
    this.notificationPattern = process.env.ONGOING_EVENT_NOTIFICATION_PATTERN || '0,10,20,30,40,50 * * * *';
    
    this.start();
  }

  /**
   * Gets the status of both cron jobs
   */
  getStatus() {
    return {
      prediction: {
        isEnabled: this.isEnabled,
        isRunning: !!this.predictionTask,
        cronPattern: this.cronPattern,
        timezone: process.env.TZ || 'UTC',
        lastRun: this.lastRunTime || null,
        nextRun: this.predictionTask ? 'Every 5 minutes' : null
      },
      ongoingEventNotifications: {
        isEnabled: this.notificationEnabled,
        isRunning: !!this.notificationTask,
        cronPattern: this.notificationPattern,
        timezone: process.env.TZ || 'UTC',
        lastNotificationRun: this.lastNotificationRunTime || null,
        nextRun: this.notificationTask ? 'Every 10 minutes' : null
      }
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
   * Gets events that are happening now (based on Malaysia timezone)
   * Events are stored in UTC but represent Malaysia local times
   */
  async getOngoingEvents() {
    try {
      // Malaysia is UTC+8
      const MALAYSIA_OFFSET_MS = 8 * 60 * 60 * 1000;
      
      // Get current time in UTC
      const nowUTC = new Date();
      
      // Get current time in Malaysia (for display/logging)
      const nowMalaysia = new Date(nowUTC.getTime() + MALAYSIA_OFFSET_MS);
      
      // Get Malaysia date boundaries (midnight to 11:59:59 PM Malaysia time)
      // Use Date.UTC to ensure we're working in UTC, then the date is already offset-adjusted
      const malaysiaTodayStart = new Date(Date.UTC(
        nowMalaysia.getUTCFullYear(),
        nowMalaysia.getUTCMonth(),
        nowMalaysia.getUTCDate(),
        0, 0, 0, 0
      ));
      const malaysiaTodayEnd = new Date(Date.UTC(
        nowMalaysia.getUTCFullYear(),
        nowMalaysia.getUTCMonth(),
        nowMalaysia.getUTCDate(),
        23, 59, 59, 999
      ));
      
      logger.info('Getting ongoing events (Malaysia timezone)', { 
        currentTimeUTC: nowUTC.toISOString(),
        currentTimeMalaysia: this.formatMalaysiaTime(nowMalaysia),
        malaysiaTodayStart: this.formatMalaysiaTime(malaysiaTodayStart),
        malaysiaTodayEnd: this.formatMalaysiaTime(malaysiaTodayEnd)
      });
      
      // Get all events
      const { events } = await eventService.getEvents(1000, 0, {});

      // Filter for events happening NOW in Malaysia timezone
      const ongoingEvents = events.filter(event => {
        if (!event.dateOfEventStart || !event.dateOfEventEnd) {
          return false;
        }

        // Event times are stored in UTC but represent Malaysia local times
        // e.g., "2025-10-09T04:00:00.000Z" = 12:00 PM Malaysia time
        const eventStartUTC = new Date(event.dateOfEventStart);
        const eventEndUTC = new Date(event.dateOfEventEnd);
        
        // Check if event is scheduled for today in Malaysia timezone
        const eventStartMalaysia = new Date(eventStartUTC.getTime() + MALAYSIA_OFFSET_MS);
        const eventStartDateOnly = new Date(Date.UTC(
          eventStartMalaysia.getUTCFullYear(),
          eventStartMalaysia.getUTCMonth(),
          eventStartMalaysia.getUTCDate()
        ));
        const todayDateOnly = new Date(Date.UTC(
          nowMalaysia.getUTCFullYear(),
          nowMalaysia.getUTCMonth(),
          nowMalaysia.getUTCDate()
        ));
        
        const isToday = eventStartDateOnly.getTime() === todayDateOnly.getTime();
        const hasForecast = !!event.forecastResult;
        
        // Require forecast - events need forecast data to generate predictions
        if (!isToday || !hasForecast) {
          return false;
        }

        // ALWAYS use actual event times, not forecast period
        // Forecast period might be outdated or incorrect
        const forecastStartUTC = eventStartUTC;
        const forecastEndUTC = eventEndUTC;
        
        // ✅ ADDITIONAL CONDITION: Start predictions 1 hour before event starts (Malaysia timezone aware)
        // Example: Event at 12:00 PM Malaysia (04:00 UTC) → Start predictions at 11:00 AM Malaysia (03:00 UTC)
        const ONE_HOUR_MS = 60 * 60 * 1000;
        const oneHourBeforeStartUTC = new Date(forecastStartUTC.getTime() - ONE_HOUR_MS);
        const oneHourBeforeStartMalaysia = new Date(oneHourBeforeStartUTC.getTime() + MALAYSIA_OFFSET_MS);
        
        // Check if current time is within the prediction window
        // 1. Must be at least 1 hour before event start (or already started)
        // 2. Must not have ended yet
        const isWithinPreStartWindow = nowUTC >= oneHourBeforeStartUTC; // At least 1 hour before start
        const hasNotEnded = nowUTC <= forecastEndUTC; // Has not ended yet
        const isOngoing = isWithinPreStartWindow && hasNotEnded;

        logger.debug('Event filter check (Malaysia timezone)', {
          eventId: event.eventId,
          eventName: event.name,
          // Event times
          eventStartUTC: eventStartUTC.toISOString(),
          eventEndUTC: eventEndUTC.toISOString(),
          eventStartMalaysia: this.formatMalaysiaTime(new Date(eventStartUTC.getTime() + MALAYSIA_OFFSET_MS)),
          eventEndMalaysia: this.formatMalaysiaTime(new Date(eventEndUTC.getTime() + MALAYSIA_OFFSET_MS)),
          // Forecast period
          forecastStartUTC: forecastStartUTC.toISOString(),
          forecastEndUTC: forecastEndUTC.toISOString(),
          // Pre-start window (1 hour before)
          oneHourBeforeStartUTC: oneHourBeforeStartUTC.toISOString(),
          oneHourBeforeStartMalaysia: this.formatMalaysiaTime(oneHourBeforeStartMalaysia),
          // Current time
          currentTimeUTC: nowUTC.toISOString(),
          currentTimeMalaysia: this.formatMalaysiaTime(nowMalaysia),
          // Conditions
          isToday,
          hasForecast,
          isWithinPreStartWindow: `${isWithinPreStartWindow} (current >= 1hr before start)`,
          hasNotEnded: `${hasNotEnded} (current <= event end)`,
          isOngoing,
          included: isOngoing
        });

        return isOngoing;
      });

      const ONE_HOUR_MS = 60 * 60 * 1000;
      
      logger.info('Filtered ongoing events (Malaysia timezone)', { 
        totalEvents: events.length,
        ongoingEvents: ongoingEvents.length,
        currentTimeMalaysia: this.formatMalaysiaTime(nowMalaysia),
        note: 'Predictions start 1 hour before event start time',
        eventDetails: ongoingEvents.map(e => {
          const startUTC = new Date(e.dateOfEventStart);
          const endUTC = new Date(e.dateOfEventEnd);
          const startMalaysia = new Date(startUTC.getTime() + MALAYSIA_OFFSET_MS);
          const endMalaysia = new Date(endUTC.getTime() + MALAYSIA_OFFSET_MS);
          const oneHourBeforeStartUTC = new Date(startUTC.getTime() - ONE_HOUR_MS);
          const oneHourBeforeStartMalaysia = new Date(oneHourBeforeStartUTC.getTime() + MALAYSIA_OFFSET_MS);
          
          return {
            eventId: e.eventId,
            name: e.name,
            predictionsStartMalaysia: this.formatMalaysiaTime(oneHourBeforeStartMalaysia),
            eventStartMalaysia: this.formatMalaysiaTime(startMalaysia),
            eventEndMalaysia: this.formatMalaysiaTime(endMalaysia)
          };
        })
      });

      return ongoingEvents;
    } catch (error) {
      logger.error('Error getting ongoing events', { error: error.message });
      return [];
    }
  }

  /**
   * Formats a date to Malaysia local time string (for logging)
   * @param {Date} date - Date object
   * @returns {string} - Formatted string (YYYY-MM-DD HH:mm:ss MYT)
   */
  formatMalaysiaTime(date) {
    // Use UTC methods since the date is already offset-adjusted
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} MYT`;
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

      // 📲 Check for high congestion and send push notifications
      await this.checkAndSendCongestionAlerts(event.eventId, updatedPredictResult);

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
   * Format timestamp for predict_result
   * Returns UTC ISO string to match forecast_result format
   * @param {string} isoTimestamp - ISO 8601 timestamp
   * @returns {string} - UTC ISO string: "2025-10-09T16:20:08.000Z"
   */
  formatTimestamp(isoTimestamp) {
    // Keep as UTC ISO format - no conversion needed
    // This ensures predict_result timestamps match forecast_result timestamps (both UTC)
    const date = new Date(isoTimestamp);
    return date.toISOString();
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
   * Manually triggers a prediction update (for testing)
   */
  async triggerManualUpdate() {
    logger.info('Manually triggering prediction update');
    await this.runPredictionUpdate();
  }

  /**
   * Check congestion levels and send push notifications for high/overcrowded gates
   * @param {string} eventId - Event ID
   * @param {Object} predictResult - Updated predict_result object
   */
  async checkAndSendCongestionAlerts(eventId, predictResult) {
    try {
      if (!predictResult || Object.keys(predictResult).length === 0) {
        logger.debug('No predict_result to check for congestion alerts', { eventId });
        return;
      }

      logger.debug('Checking congestion levels for push notifications', { 
        eventId,
        gateCount: Object.keys(predictResult).length
      });

      // Analyze each gate
      for (const [gateId, gateData] of Object.entries(predictResult)) {
        if (!gateData.timeFrames || gateData.timeFrames.length === 0) {
          continue;
        }

        // Get the most recent timeframe
        const latestTimeFrame = gateData.timeFrames[gateData.timeFrames.length - 1];
        const capacity = gateData.capacity || 100;
        const actual = latestTimeFrame.actual || 0;

        // Calculate congestion percentage
        const congestionPercentage = (actual / capacity) * 100;

        // Determine congestion level
        let level = 'Low';
        if (congestionPercentage >= 100) {
          level = 'Overcrowded';
        } else if (congestionPercentage >= 80) {
          level = 'High';
        } else if (congestionPercentage >= 50) {
          level = 'Moderate';
        }

        logger.debug('Gate congestion analysis', {
          eventId,
          gateId,
          actual,
          capacity,
          congestionPercentage: congestionPercentage.toFixed(1),
          level
        });

        // Send notification for High or Overcrowded levels
        if (level === 'High' || level === 'Overcrowded') {
          try {
            await pushNotificationService.sendCongestionAlert(
              eventId,
              gateId,
              level,
              actual
            );

            logger.info('📲 Sent congestion alert notification', {
              eventId,
              gateId,
              level,
              peopleCount: actual,
              capacity,
              congestionPercentage: congestionPercentage.toFixed(1)
            });
          } catch (notificationError) {
            // Log error but don't fail the prediction update
            logger.error('Failed to send congestion alert notification', {
              eventId,
              gateId,
              level,
              error: notificationError.message
            });
          }
        }
      }

    } catch (error) {
      // Log error but don't fail the prediction update
      logger.error('Error checking congestion alerts', {
        eventId,
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Run ongoing event notifications for events that are currently happening
   */
  async runOngoingEventNotifications() {
    try {
      this.lastNotificationRunTime = new Date().toISOString();
      
      logger.info('📢 Starting ongoing event notification cron job', {
        timestamp: this.lastNotificationRunTime
      });

      // Find events that are currently ongoing
      const ongoingEvents = await this.getOngoingEventsForNotifications();

      if (ongoingEvents.length === 0) {
        logger.info('📢 No ongoing events found for notifications');
        return;
      }

      logger.info('📢 Found ongoing events for notifications', { 
        count: ongoingEvents.length,
        eventIds: ongoingEvents.map(e => e.eventId)
      });

      // Send notifications for each ongoing event
      const results = await Promise.allSettled(
        ongoingEvents.map(event => this.sendOngoingEventNotification(event))
      );

      // Log results
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      logger.info('📢 Ongoing event notification cron job completed', {
        totalEvents: ongoingEvents.length,
        successful,
        failed,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('❌ Error in ongoing event notification cron job', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Get events that are currently ongoing (current time between start and end dates)
   */
  async getOngoingEventsForNotifications() {
    try {
      logger.info('🔍 Fetching ongoing events for notifications');

      // Get current time in UTC and Malaysia timezone
      const nowUTC = new Date();
      const MALAYSIA_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8 in milliseconds
      const nowMalaysia = new Date(nowUTC.getTime() + MALAYSIA_OFFSET_MS);

      logger.info('⏰ Time information for ongoing events check', {
        nowUTC: nowUTC.toISOString(),
        nowMalaysia: this.formatMalaysiaTime(nowMalaysia)
      });

      // Fetch all events
      const { events } = await eventService.getEvents(1000, 0, {});

      if (!events || events.length === 0) {
        logger.info('📅 No events found in database');
        return [];
      }

      logger.info('📅 Retrieved events for ongoing check', { 
        totalEvents: events.length 
      });

      const ongoingEvents = events.filter(event => {
        // Parse event start and end times (they are in UTC in the database)
        const eventStartUTC = new Date(event.dateOfEventStart);
        const eventEndUTC = new Date(event.dateOfEventEnd);

        // Convert to Malaysia time for comparison
        const eventStartMalaysia = new Date(eventStartUTC.getTime() + MALAYSIA_OFFSET_MS);
        const eventEndMalaysia = new Date(eventEndUTC.getTime() + MALAYSIA_OFFSET_MS);

        // Check if current time is between start and end
        const isCurrentlyOngoing = nowMalaysia >= eventStartMalaysia && nowMalaysia <= eventEndMalaysia;

        // Check if we already sent a notification recently (within last 30 minutes)
        const lastNotificationTime = this.lastNotificationTimes.get(event.eventId);
        const thirtyMinutesAgo = nowUTC.getTime() - (30 * 60 * 1000);
        const shouldSendNotification = !lastNotificationTime || lastNotificationTime < thirtyMinutesAgo;

        if (isCurrentlyOngoing) {
          logger.debug('🎪 Event currently ongoing', {
            eventId: event.eventId,
            name: event.name,
            eventStartMalaysia: this.formatMalaysiaTime(eventStartMalaysia),
            eventEndMalaysia: this.formatMalaysiaTime(eventEndMalaysia),
            currentTime: this.formatMalaysiaTime(nowMalaysia),
            lastNotificationTime: lastNotificationTime ? new Date(lastNotificationTime).toISOString() : 'never',
            shouldSendNotification
          });
        }

        return isCurrentlyOngoing && shouldSendNotification;
      });

      logger.info('🎪 Filtered ongoing events for notifications', {
        ongoingCount: ongoingEvents.length,
        eventDetails: ongoingEvents.map(e => ({
          eventId: e.eventId,
          name: e.name,
          venue: e.venue
        }))
      });

      return ongoingEvents;

    } catch (error) {
      logger.error('❌ Error fetching ongoing events for notifications', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Send notification for a single ongoing event
   */
  async sendOngoingEventNotification(event) {
    try {
      logger.info('📲 Sending ongoing event notification', {
        eventId: event.eventId,
        name: event.name,
        venue: event.venue
      });

      // Get subscription count to decide if it's worth sending
      const subscriptionCount = await pushNotificationService.getSubscriptionCount(event.eventId);

      if (subscriptionCount === 0) {
        logger.info('📭 No subscribers for event, skipping notification', {
          eventId: event.eventId
        });
        return { eventId: event.eventId, success: true, reason: 'no_subscribers' };
      }

      // Send the notification
      const result = await pushNotificationService.sendToEvent(event.eventId, {
        title: `🎪 ${event.name} is Live!`,
        body: `The event at ${event.venue} is currently happening. Join us now!`,
        tag: 'event-live',
        requireInteraction: false,
        data: {
          type: 'event_live',
          eventId: event.eventId,
          eventName: event.name,
          venue: event.venue,
          timestamp: Date.now()
        }
      });

      // Update last notification time
      this.lastNotificationTimes.set(event.eventId, Date.now());

      logger.info('✅ Ongoing event notification sent successfully', {
        eventId: event.eventId,
        sent: result.sent,
        failed: result.failed,
        subscriptionCount
      });

      return {
        eventId: event.eventId,
        success: true,
        sent: result.sent,
        failed: result.failed
      };

    } catch (error) {
      logger.error('❌ Error sending ongoing event notification', {
        eventId: event.eventId,
        error: error.message
      });
      return {
        eventId: event.eventId,
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new CronService();
