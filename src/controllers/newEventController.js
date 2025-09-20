const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');

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
  defaultMeta: { service: 'event-controller' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Custom validation for date range
const validateDateRange = (value, { req }) => {
  const startDate = new Date(req.body.dateOfEventStart);
  const endDate = new Date(value);
  
  if (endDate <= startDate) {
    throw new Error('End date must be after start date');
  }
  
  return true;
};

// Validation middleware for creating events
const validateCreateEvent = [
  body('name')
    .isString()
    .isLength({ min: 1, max: 255 })
    .trim()
    .withMessage('Event name is required and must be 1-255 characters'),
  body('description')
    .optional()
    .isString()
    .isLength({ max: 5000 })
    .trim()
    .withMessage('Description must be a string with max 5000 characters'),
  body('venue')
    .optional()
    .isString()
    .isLength({ min: 1, max: 255 })
    .trim()
    .withMessage('Venue must be 1-255 characters'),
  body('dateOfEventStart')
    .isISO8601()
    .withMessage('Event start date must be a valid ISO 8601 date'),
  body('dateOfEventEnd')
    .isISO8601()
    .withMessage('Event end date must be a valid ISO 8601 date')
    .custom(validateDateRange),
  body('status')
    .optional()
    .isIn(['CREATED', 'ACTIVE', 'COMPLETED', 'CANCELLED'])
    .withMessage('Status must be one of: CREATED, ACTIVE, COMPLETED, CANCELLED'),
  body('venueLayout')
    .optional()
    .isObject()
    .withMessage('Venue layout must be a valid JSON object'),
  body('userEmail')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid user email is required')
];

// Validation middleware for updating events
const validateUpdateEvent = [
  body('name')
    .optional()
    .isString()
    .isLength({ min: 1, max: 255 })
    .trim()
    .withMessage('Event name must be 1-255 characters'),
  body('description')
    .optional()
    .isString()
    .isLength({ max: 5000 })
    .trim()
    .withMessage('Description must be a string with max 5000 characters'),
  body('venue')
    .optional()
    .isString()
    .isLength({ min: 1, max: 255 })
    .trim()
    .withMessage('Venue must be 1-255 characters'),
  body('dateOfEventStart')
    .optional()
    .isISO8601()
    .withMessage('Event start date must be a valid ISO 8601 date'),
  body('dateOfEventEnd')
    .optional()
    .isISO8601()
    .withMessage('Event end date must be a valid ISO 8601 date')
    .custom((value, { req }) => {
      // Only validate if both dates are provided
      if (req.body.dateOfEventStart && value) {
        return validateDateRange(value, { req });
      }
      return true;
    }),
  body('status')
    .optional()
    .isIn(['CREATED', 'ACTIVE', 'COMPLETED', 'CANCELLED'])
    .withMessage('Status must be one of: CREATED, ACTIVE, COMPLETED, CANCELLED'),
  body('venueLayout')
    .optional()
    .isObject()
    .withMessage('Venue layout must be a valid JSON object'),
  body('userEmail')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid user email is required')
];

/**
 * POST /events
 * Creates a new event
 */
router.post('/', validateCreateEvent, asyncHandler(async (req, res) => {
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

  const { name, description, venue, dateOfEventStart, dateOfEventEnd, status, venueLayout, userEmail } = req.body;
  const eventId = `evt_${uuidv4()}`;

  logger.info('Creating new event', { eventId, name });

  try {
    const eventData = {
      eventId,
      name,
      description,
      venue,
      dateOfEventStart,
      dateOfEventEnd,
      status,
      venueLayout,
      userEmail
    };

    const event = await eventService.createEvent(eventData);

    logger.info('Event created successfully', { eventId, name });

    res.status(201).json({
      success: true,
      data: event,
      message: 'Event created successfully'
    });

  } catch (error) {
    logger.error('Error creating event', { eventId, name, error: error.message });
    
    if (error.message.includes('already exists')) {
      return res.status(409).json({
        success: false,
        error: {
          status: 'fail',
          message: error.message,
          code: 'DUPLICATE_RESOURCE'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }
    
    throw new AppError('Failed to create event', 500, error.message);
  }
}));

/**
 * GET /events
 * Retrieves all events with pagination and filtering
 * 
 * Query Parameters:
 * - userEmail: Filter events by creator email (optional)
 * - myEvents: If true, filter by authenticated user's email (optional)
 * - upcoming/past/ongoing: Filter by event status (optional)
 * - withForecast: Filter events with forecast data (optional)
 * - search: Search in event names (optional)
 * - startDate/endDate: Filter by date range (optional)
 * 
 * Headers:
 * - x-user-email: User's email for authentication context (optional)
 */
router.get('/', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 100); // Max 100 per page
  const offset = (page - 1) * limit;

  const filters = {};
  
  // Handle user email filtering
  if (req.query.userEmail) {
    // Explicit user email provided in query
    filters.userEmail = req.query.userEmail;
  } else if (req.query.myEvents === 'true') {
    // Filter by authenticated user's email from header
    const userEmail = req.headers['x-user-email'] || req.headers['user-email'];
    if (userEmail) {
      filters.userEmail = userEmail;
    } else {
      return res.status(400).json({
        success: false,
        error: {
          status: 'fail',
          message: 'User email required for myEvents filter',
          code: 'MISSING_USER_EMAIL',
          details: 'To use myEvents=true, provide user email in x-user-email header or userEmail query parameter'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }
  }
  
  // Other filters
  if (req.query.upcoming === 'true') filters.upcoming = true;
  if (req.query.past === 'true') filters.past = true;
  if (req.query.ongoing === 'true') filters.ongoing = true;
  if (req.query.withForecast === 'true') filters.withForecast = true;
  if (req.query.search) filters.search = req.query.search;
  if (req.query.startDate) filters.startDate = req.query.startDate;
  if (req.query.endDate) filters.endDate = req.query.endDate;
  if (req.query.status) filters.status = req.query.status;
  if (req.query.venue) filters.venue = req.query.venue;

  logger.info('Retrieving events', { page, limit, filters, requestedBy: filters.userEmail || 'anonymous' });

  try {
    const result = await eventService.getEvents(limit, offset, filters);

    const totalPages = Math.ceil(result.total / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    res.status(200).json({
      success: true,
      data: {
        events: result.events,
        filters: {
          userEmail: filters.userEmail || null,
          isMyEvents: !!req.query.myEvents,
          appliedFilters: Object.keys(filters).filter(key => filters[key] !== undefined)
        },
        pagination: {
          currentPage: page,
          totalPages,
          totalItems: result.total,
          itemsPerPage: limit,
          hasNextPage,
          hasPreviousPage
        }
      }
    });

  } catch (error) {
    logger.error('Error retrieving events', { error: error.message });
    throw new AppError('Failed to retrieve events', 500, error.message);
  }
}));

/**
 * GET /events/statistics
 * Retrieves event statistics
 */
router.get('/statistics', asyncHandler(async (req, res) => {
  logger.info('Retrieving event statistics');

  try {
    const statistics = await eventService.getEventStatistics();

    res.status(200).json({
      success: true,
      data: statistics
    });

  } catch (error) {
    logger.error('Error retrieving event statistics', { error: error.message });
    throw new AppError('Failed to retrieve event statistics', 500, error.message);
  }
}));

/**
 * GET /events/user/:userEmail
 * Retrieves all events created by a specific user
 */
router.get('/user/:userEmail', asyncHandler(async (req, res) => {
  const { userEmail } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 100); // Max 100 per page
  const offset = (page - 1) * limit;

  // Additional filters
  const additionalFilters = {};
  if (req.query.upcoming === 'true') additionalFilters.upcoming = true;
  if (req.query.past === 'true') additionalFilters.past = true;
  if (req.query.ongoing === 'true') additionalFilters.ongoing = true;
  if (req.query.withForecast === 'true') additionalFilters.withForecast = true;
  if (req.query.search) additionalFilters.search = req.query.search;
  if (req.query.startDate) additionalFilters.startDate = req.query.startDate;
  if (req.query.endDate) additionalFilters.endDate = req.query.endDate;
  if (req.query.status) additionalFilters.status = req.query.status;
  if (req.query.venue) additionalFilters.venue = req.query.venue;

  logger.info('Retrieving events by user', { userEmail, page, limit, additionalFilters });

  try {
    const result = await eventService.getEventsByUser(userEmail, limit, offset, additionalFilters);

    const totalPages = Math.ceil(result.total / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    res.status(200).json({
      success: true,
      data: {
        events: result.events,
        userEmail,
        pagination: {
          currentPage: page,
          totalPages,
          totalItems: result.total,
          itemsPerPage: limit,
          hasNextPage,
          hasPreviousPage
        }
      }
    });

  } catch (error) {
    logger.error('Error retrieving events by user', { userEmail, error: error.message });
    throw new AppError('Failed to retrieve events for user', 500, error.message);
  }
}));

/**
 * GET /events/:eventId
 * Retrieves a specific event by ID
 */
router.get('/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  logger.info('Retrieving event by ID', { eventId });

  try {
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

    res.status(200).json({
      success: true,
      data: event
    });

  } catch (error) {
    logger.error('Error retrieving event', { eventId, error: error.message });
    throw new AppError('Failed to retrieve event', 500, error.message);
  }
}));

/**
 * PUT /events/:eventId
 * Updates an existing event
 */
router.put('/:eventId', validateUpdateEvent, asyncHandler(async (req, res) => {
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

  const { eventId } = req.params;
  const updateData = req.body;

  logger.info('Updating event', { eventId });

  try {
    // Check if event exists
    const existingEvent = await eventService.getEventById(eventId);
    if (!existingEvent) {
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

    const updatedEvent = await eventService.updateEvent(eventId, updateData);

    logger.info('Event updated successfully', { eventId });

    res.status(200).json({
      success: true,
      data: updatedEvent,
      message: 'Event updated successfully'
    });

  } catch (error) {
    logger.error('Error updating event', { eventId, error: error.message });
    throw new AppError('Failed to update event', 500, error.message);
  }
}));

/**
 * DELETE /events/:eventId
 * Deletes an event
 */
router.delete('/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  logger.info('Deleting event', { eventId });

  try {
    // Check if event exists
    const existingEvent = await eventService.getEventById(eventId);
    if (!existingEvent) {
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

    await eventService.deleteEvent(eventId);

    logger.info('Event deleted successfully', { eventId });

    res.status(200).json({
      success: true,
      message: 'Event deleted successfully'
    });

  } catch (error) {
    logger.error('Error deleting event', { eventId, error: error.message });
    throw new AppError('Failed to delete event', 500, error.message);
  }
}));

module.exports = router;
