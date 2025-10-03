const express = require('express');
const winston = require('winston');

const eventService = require('../services/eventService');
const predictionService = require('../services/predictionService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

const router = express.Router();

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'prediction-controller' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

/**
 * POST /prediction/:eventId
 * Gets real-time prediction for an event
 */
router.post('/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  logger.info('Getting prediction for event', { eventId });

  try {
    // Get event with forecast_result
    const event = await eventService.getEvent(eventId);
    
    if (!event) {
      return res.status(404).json({
        success: false,
        error: {
          status: 'fail',
          message: 'Event not found',
          code: 'EVENT_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    // Check if event has forecast_result
    if (!event.forecastResult) {
      return res.status(400).json({
        success: false,
        error: {
          status: 'fail',
          message: 'Event must have forecast_result before getting predictions',
          code: 'FORECAST_REQUIRED'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    // Get prediction from the model
    const predictionResult = await predictionService.getPrediction(event);

    // Check if prediction failed
    if (predictionResult.error) {
      logger.warn('Prediction failed for event', { 
        eventId, 
        error: predictionResult.message 
      });
      
      return res.status(503).json({
        success: false,
        error: {
          status: 'error',
          message: 'Prediction service unavailable',
          details: predictionResult.message,
          code: 'PREDICTION_SERVICE_ERROR'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    // Update event with prediction result
    const updatedEvent = await eventService.updateEvent(eventId, {
      predictResult: predictionResult
    });

    logger.info('Prediction completed and saved', { 
      eventId,
      predictionsCount: predictionResult.predictions?.length || 0
    });

    res.status(200).json({
      success: true,
      data: {
        eventId,
        predictionResult,
        event: updatedEvent,
        updatedAt: new Date().toISOString()
      },
      message: 'Prediction completed successfully'
    });

  } catch (error) {
    logger.error('Error getting prediction', { eventId, error: error.message });
    throw new AppError('Failed to get prediction', 500, error.message);
  }
}));

/**
 * GET /prediction/:eventId
 * Gets the latest prediction result for an event
 */
router.get('/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  logger.info('Retrieving prediction result for event', { eventId });

  try {
    const event = await eventService.getEvent(eventId);
    
    if (!event) {
      return res.status(404).json({
        success: false,
        error: {
          status: 'fail',
          message: 'Event not found',
          code: 'EVENT_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        eventId,
        predictResult: event.predictResult,
        hasPrediction: !!event.predictResult,
        hasForecast: !!event.forecastResult,
        lastUpdated: event.updatedAt
      },
      message: 'Prediction result retrieved successfully'
    });

  } catch (error) {
    logger.error('Error retrieving prediction result', { eventId, error: error.message });
    throw new AppError('Failed to retrieve prediction result', 500, error.message);
  }
}));

/**
 * GET /prediction/health/model
 * Checks the health of the prediction model service
 */
router.get('/health/model', asyncHandler(async (req, res) => {
  logger.info('Checking prediction model health');

  try {
    const healthResult = await predictionService.healthCheck();

    const statusCode = healthResult.healthy ? 200 : 503;

    res.status(statusCode).json({
      success: healthResult.healthy,
      data: healthResult,
      message: healthResult.healthy 
        ? 'Prediction model service is healthy' 
        : 'Prediction model service is unavailable'
    });

  } catch (error) {
    logger.error('Error checking prediction model health', { error: error.message });
    
    res.status(503).json({
      success: false,
      error: {
        status: 'error',
        message: 'Unable to check prediction model service health',
        code: 'HEALTH_CHECK_FAILED'
      },
      timestamp: new Date().toISOString(),
      requestId: req.headers['x-request-id'] || 'unknown'
    });
  }
}));

/**
 * GET /prediction/debug/events
 * Debug endpoint to see which events would be selected for prediction updates
 */
router.get('/debug/events', asyncHandler(async (req, res) => {
  logger.info('Debug: Getting events for prediction update');
  
  try {
    const cronService = require('../services/cronService');
    const events = await cronService.getOngoingEvents();
    
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    
    // Also get all events to compare
    const { events: allEvents } = await eventService.getEvents(1000, 0, {});
    
    res.status(200).json({
      success: true,
      data: {
        serverTime: {
          current: now.toISOString(),
          currentLocal: now.toString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          todayStart: todayStart.toISOString(),
          todayEnd: todayEnd.toISOString()
        },
        selectedEvents: events.map(event => ({
          eventId: event.eventId,
          name: event.name,
          dateOfEventStart: event.dateOfEventStart,
          dateOfEventEnd: event.dateOfEventEnd,
          hasForecastResult: !!event.forecastResult,
          status: event.status
        })),
        allActiveEvents: allEvents.map(event => {
          const eventStart = new Date(event.dateOfEventStart);
          const eventEnd = new Date(event.dateOfEventEnd);
          const eventStartDate = new Date(eventStart.getFullYear(), eventStart.getMonth(), eventStart.getDate());
          const todayDate = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate());
          
          return {
            eventId: event.eventId,
            name: event.name,
            dateOfEventStart: event.dateOfEventStart,
            dateOfEventEnd: event.dateOfEventEnd,
            hasForecastResult: !!event.forecastResult,
            status: event.status,
            debugInfo: {
              eventStartDate: eventStartDate.toISOString(),
              todayDate: todayDate.toISOString(),
              isToday: eventStartDate.getTime() === todayDate.getTime(),
              hasNotEnded: now <= eventEnd,
              wouldBeSelected: eventStartDate.getTime() === todayDate.getTime() && !!event.forecastResult && now <= eventEnd
            }
          };
        }),
        totalSelectedEvents: events.length,
        totalActiveEvents: allEvents.length
      },
      message: 'Debug information for prediction events'
    });
  } catch (error) {
    logger.error('Error in debug events endpoint', { error: error.message });
    throw new AppError('Failed to get debug information', 500, error.message);
  }
}));

module.exports = router;
