const express = require('express');
const { body, validationResult } = require('express-validator');
const winston = require('winston');

const forecastService = require('../services/forecastService');
const eventService = require('../services/eventService');
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
  defaultMeta: { service: 'forecast-controller' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Validation middleware for forecast generation
const validateForecastGeneration = [
  body('eventId')
    .isString()
    .notEmpty()
    .withMessage('Event ID is required'),
  body('inputData')
    .optional()
    .isObject()
    .withMessage('Input data must be an object'),
  body('inputData.historicalData')
    .optional()
    .isObject()
    .withMessage('Historical data must be an object'),
  body('inputData.weatherData')
    .optional()
    .isObject()
    .withMessage('Weather data must be an object'),
  body('inputData.promotionalData')
    .optional()
    .isObject()
    .withMessage('Promotional data must be an object'),
  body('inputData.expectedAttendance')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Expected attendance must be a positive integer'),
  body('inputData.ticketsSold')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Tickets sold must be a non-negative integer')
];

/**
 * POST /forecast
 * Generates crowd forecast for an event
 */
router.post('/', validateForecastGeneration, asyncHandler(async (req, res) => {
  // Check for validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        status: 'fail',
        message: 'Validation failed',
        details: errors.array()
      },
      timestamp: new Date().toISOString(),
      requestId: req.headers['x-request-id'] || 'unknown'
    });
  }

  const { eventId, inputData = {} } = req.body;

  logger.info('Generating forecast for event', { eventId });

  try {
    // Validate input data
    const validation = forecastService.validateForecastInput({ event_id: eventId, ...inputData });
    
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        error: {
          status: 'fail',
          message: 'Invalid forecast input data',
          details: validation.errors
        },
        warnings: validation.warnings,
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    // Check if event exists
    const event = await eventService.getEventById(eventId);
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

    // Generate forecast
    const forecastResult = await forecastService.generateForecast(eventId, inputData);

    logger.info('Forecast generated successfully', { eventId });

    res.status(200).json({
      success: true,
      data: forecastResult,
      message: 'Forecast generated successfully',
      warnings: validation.warnings.length > 0 ? validation.warnings : undefined
    });

  } catch (error) {
    logger.error('Error generating forecast', { eventId, error: error.message });
    
    if (error.message.includes('Event not found')) {
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

    if (error.message.includes('model service is unavailable') || 
        error.message.includes('endpoint not found') ||
        error.message.includes('timed out')) {
      return res.status(503).json({
        success: false,
        error: {
          status: 'error',
          message: 'AI model service unavailable',
          code: 'SERVICE_UNAVAILABLE',
          details: error.message
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }
    
    throw new AppError('Failed to generate forecast', 500, error.message);
  }
}));

/**
 * GET /forecast/:eventId
 * Retrieves existing forecast for an event
 */
router.get('/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  logger.info('Retrieving forecast for event', { eventId });

  try {
    const forecast = await forecastService.getForecast(eventId);

    if (!forecast) {
      return res.status(404).json({
        success: false,
        error: {
          status: 'fail',
          message: 'Forecast not found for this event',
          code: 'FORECAST_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    res.status(200).json({
      success: true,
      data: forecast
    });

  } catch (error) {
    logger.error('Error retrieving forecast', { eventId, error: error.message });
    
    if (error.message.includes('Event not found')) {
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
    
    throw new AppError('Failed to retrieve forecast', 500, error.message);
  }
}));

/**
 * DELETE /forecast/:eventId
 * Deletes forecast for an event
 */
router.delete('/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  logger.info('Deleting forecast for event', { eventId });

  try {
    // Check if event exists
    const event = await eventService.getEventById(eventId);
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

    await forecastService.deleteForecast(eventId);

    logger.info('Forecast deleted successfully', { eventId });

    res.status(200).json({
      success: true,
      message: 'Forecast deleted successfully'
    });

  } catch (error) {
    logger.error('Error deleting forecast', { eventId, error: error.message });
    throw new AppError('Failed to delete forecast', 500, error.message);
  }
}));

/**
 * POST /forecast/regenerate/:eventId
 * Regenerates forecast for an event (convenience endpoint)
 */
router.post('/regenerate/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;
  const inputData = req.body || {};

  logger.info('Regenerating forecast for event', { eventId });

  try {
    // Check if event exists
    const event = await eventService.getEventById(eventId);
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

    // Generate new forecast (will overwrite existing one)
    const forecastResult = await forecastService.generateForecast(eventId, inputData);

    logger.info('Forecast regenerated successfully', { eventId });

    res.status(200).json({
      success: true,
      data: forecastResult,
      message: 'Forecast regenerated successfully'
    });

  } catch (error) {
    logger.error('Error regenerating forecast', { eventId, error: error.message });
    
    if (error.message.includes('model service is unavailable') || 
        error.message.includes('endpoint not found') ||
        error.message.includes('timed out')) {
      return res.status(503).json({
        success: false,
        error: {
          status: 'error',
          message: 'AI model service unavailable',
          code: 'SERVICE_UNAVAILABLE',
          details: error.message
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }
    
    throw new AppError('Failed to regenerate forecast', 500, error.message);
  }
}));

/**
 * GET /forecast/health/model
 * Check AI model service health
 */
router.get('/health/model', asyncHandler(async (req, res) => {
  logger.info('Checking AI model service health');

  try {
    const isHealthy = await forecastService.testModelConnection();

    res.status(200).json({
      success: true,
      data: {
        modelEndpoint: process.env.AI_MODEL_ENDPOINT || 'http://localhost:8080/predict',
        isHealthy,
        checkedAt: new Date().toISOString()
      },
      message: isHealthy ? 'AI model service is healthy' : 'AI model service is unavailable'
    });

  } catch (error) {
    logger.error('Error checking model health', { error: error.message });
    
    res.status(503).json({
      success: false,
      error: {
        status: 'error',
        message: 'Unable to check AI model service health',
        code: 'SERVICE_UNAVAILABLE'
      },
      data: {
        modelEndpoint: process.env.AI_MODEL_ENDPOINT || 'http://localhost:8080/predict',
        isHealthy: false,
        checkedAt: new Date().toISOString()
      },
      timestamp: new Date().toISOString(),
      requestId: req.headers['x-request-id'] || 'unknown'
    });
  }
}));

module.exports = router;
