const cron = require('node-cron');
const winston = require('winston');
const eventService = require('./eventService');
const predictionService = require('./predictionService');

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
    this.predictionTask = null;
    this.isEnabled = process.env.ENABLE_PREDICTION_CRON === 'true';
    // Run at standard 5-minute intervals: :00, :05, :10, :15, :20, :25, :30, :35, :40, :45, :50, :55
    this.cronPattern = process.env.PREDICTION_CRON_PATTERN || '0,5,10,15,20,25,30,35,40,45,50,55 * * * *';
    
    logger.info('CronService initialized', { 
      isEnabled: this.isEnabled,
      cronPattern: this.cronPattern,
      description: 'Runs at standard 5-minute intervals (:00, :05, :10, :15, :20, :25, :30, :35, :40, :45, :50, :55)'
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
            forecastStart = new Date(period.start);
          }
          if (period.end) {
            forecastEnd = new Date(period.end);
          }
        }
        
        // Check if current time is within forecast period
        const hasStarted = now >= forecastStart;
        const hasNotEnded = now <= forecastEnd;
        const isOngoing = hasStarted && hasNotEnded;

        logger.debug('Event filter check', {
          eventId: event.eventId,
          eventStart: eventStart.toISOString(),
          eventEnd: eventEnd.toISOString(),
          forecastStart: forecastStart.toISOString(),
          forecastEnd: forecastEnd.toISOString(),
          currentTime: now.toISOString(),
          isToday,
          hasForecast,
          hasStarted,
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

    // Extract predictions from the new result
    const predictions = newPredictionResult.predictions || [];
    const timestamp = newPredictionResult.metadata?.requestedAt || new Date().toISOString();

    // Get gate capacities from forecast_result
    const gateCapacities = this.extractGateCapacitiesFromForecast(event.forecastResult);

    // Group predictions by gate_id
    predictions.forEach(prediction => {
      const gateId = prediction.gate_id;
      
      // Get correct capacity from forecast_result
      const correctCapacity = gateCapacities[gateId] || prediction.total_capacity || 100;
      
      // Initialize gate structure if it doesn't exist
      if (!merged[gateId]) {
        merged[gateId] = {
          capacity: correctCapacity,
          timeFrames: []
        };
      } else if (merged[gateId].capacity !== correctCapacity) {
        // Update capacity if it changed
        merged[gateId].capacity = correctCapacity;
      }

      // ✅ Extract values from correct model response fields
      const predicted = prediction.forecast_next_5_min?.predicted_people_count ?? 0;
      const actual = prediction.current_people_count ?? 0;

      // Create new timeframe entry
      const newTimeFrame = {
        predicted,
        actual,
        timestamp: this.formatTimestamp(timestamp),
        dataSource: 'ai_model'
      };

      // Append to timeFrames array (don't replace!)
      merged[gateId].timeFrames.push(newTimeFrame);

      logger.debug('Appended prediction timeframe', {
        gateId,
        timestamp: newTimeFrame.timestamp,
        predicted: newTimeFrame.predicted,
        actual: newTimeFrame.actual,
        capacity: correctCapacity,
        totalTimeFrames: merged[gateId].timeFrames.length
      });
    });

    return merged;
  }

  /**
   * Extracts gate capacities from forecast_result
   * @param {Object} forecastResult - Forecast result object
   * @returns {Object} - Map of gate_id to capacity
   */
  extractGateCapacitiesFromForecast(forecastResult) {
    const capacities = {};
    
    if (!forecastResult) {
      return capacities;
    }

    // Check forecast_result.summary.predictions for capacity
    if (forecastResult.summary?.predictions) {
      forecastResult.summary.predictions.forEach(pred => {
        if (pred.gate && pred.capacity) {
          capacities[pred.gate] = pred.capacity;
        }
      });
    }

    // Check forecast_result.forecast for capacity (alternative structure)
    if (forecastResult.forecast) {
      Object.keys(forecastResult.forecast).forEach(gateId => {
        const gateData = forecastResult.forecast[gateId];
        if (gateData.capacity) {
          capacities[gateId] = gateData.capacity;
        }
      });
    }

    logger.debug('Extracted gate capacities from forecast', { capacities });

    return capacities;
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
}

module.exports = new CronService();
