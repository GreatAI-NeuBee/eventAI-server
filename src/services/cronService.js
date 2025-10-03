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
        
        // Additional check: only include if event hasn't ended yet
        const hasNotEnded = now <= eventEnd;

        logger.debug('Event filter check', {
          eventId: event.eventId,
          eventStart: eventStart.toISOString(),
          eventEnd: eventEnd.toISOString(),
          isToday,
          hasForecast,
          hasNotEnded,
          included: isToday && hasForecast && hasNotEnded
        });

        return isToday && hasForecast && hasNotEnded;
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

      // Update event with new prediction result
      await eventService.updateEvent(event.eventId, {
        predictResult: predictionResult
      });

      logger.info('Successfully updated prediction for event', { 
        eventId: event.eventId,
        predictionsCount: predictionResult.predictions?.length || 0
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
   * Manually triggers a prediction update (for testing)
   */
  async triggerManualUpdate() {
    logger.info('Manually triggering prediction update');
    await this.runPredictionUpdate();
  }
}

module.exports = new CronService();
