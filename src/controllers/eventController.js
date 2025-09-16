const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');

const s3Service = require('../services/s3Service');
const rdsService = require('../services/rdsService');
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

// Validation middleware for creating events
const validateCreateEvent = [
  body('name')
    .isString()
    .isLength({ min: 1, max: 255 })
    .withMessage('Event name must be between 1 and 255 characters'),
  body('description')
    .optional()
    .isString()
    .isLength({ max: 1000 })
    .withMessage('Description must not exceed 1000 characters'),
  body('venue')
    .isString()
    .isLength({ min: 1, max: 255 })
    .withMessage('Venue must be between 1 and 255 characters'),
  body('expectedAttendees')
    .isInt({ min: 1, max: 100000 })
    .withMessage('Expected attendees must be between 1 and 100,000'),
  body('eventDate')
    .isISO8601()
    .withMessage('Event date must be a valid ISO 8601 date'),
  body('eventType')
    .isIn(['concert', 'conference', 'sports', 'festival', 'other'])
    .withMessage('Event type must be one of: concert, conference, sports, festival, other'),
  body('ticketingData')
    .optional()
    .isObject()
    .withMessage('Ticketing data must be an object'),
  body('seatingChart')
    .optional()
    .isObject()
    .withMessage('Seating chart must be an object')
];

/**
 * POST /events
 * Creates a new event with optional file uploads
 */
router.post('/', validateCreateEvent, asyncHandler(async (req, res) => {
  // Check for validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError('Validation failed', 400, errors.array());
  }

  const {
    name,
    description,
    venue,
    expectedAttendees,
    eventDate,
    eventType,
    ticketingData,
    seatingChart
  } = req.body;

  // Generate unique IDs
  const eventId = `evt_${uuidv4()}`;
  const simulationId = `sim_${uuidv4()}`;

  logger.info('Creating new event', { eventId, name, venue });

  try {
    // Prepare S3 upload promises for datasets
    const uploadPromises = [];
    const s3Keys = {};

    // Upload ticketing data to S3 if provided
    if (ticketingData) {
      const ticketingKey = `events/${eventId}/ticketing-data.json`;
      uploadPromises.push(
        s3Service.uploadJson(ticketingKey, ticketingData)
          .then(() => { s3Keys.ticketingData = ticketingKey; })
      );
    }

    // Upload seating chart to S3 if provided
    if (seatingChart) {
      const seatingKey = `events/${eventId}/seating-chart.json`;
      uploadPromises.push(
        s3Service.uploadJson(seatingKey, seatingChart)
          .then(() => { s3Keys.seatingChart = seatingKey; })
      );
    }

    // Wait for all S3 uploads to complete
    await Promise.all(uploadPromises);

    // Create event record in RDS
    const eventData = {
      eventId,
      simulationId,
      name,
      description,
      venue,
      expectedAttendees,
      eventDate: new Date(eventDate),
      eventType,
      s3Keys,
      status: 'CREATED',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await rdsService.createEvent(eventData);

    logger.info('Event created successfully', { eventId, simulationId });

    res.status(201).json({
      success: true,
      data: {
        eventId,
        simulationId,
        name,
        venue,
        status: 'CREATED',
        createdAt: eventData.createdAt
      },
      message: 'Event created successfully'
    });

  } catch (error) {
    logger.error('Error creating event', { eventId, error: error.message });
    
    // Clean up any uploaded files in case of error
    try {
      if (Object.keys(s3Keys).length > 0) {
        await s3Service.deleteObjects(Object.values(s3Keys));
      }
    } catch (cleanupError) {
      logger.error('Error cleaning up S3 objects', { cleanupError: cleanupError.message });
    }

    throw new AppError('Failed to create event', 500, error.message);
  }
}));

/**
 * GET /events/:eventId
 * Retrieves event details by ID
 */
router.get('/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  if (!eventId || !eventId.startsWith('evt_')) {
    throw new AppError('Invalid event ID format', 400);
  }

  logger.info('Retrieving event', { eventId });

  try {
    const event = await rdsService.getEventById(eventId);

    if (!event) {
      throw new AppError('Event not found', 404);
    }

    // Get additional data from S3 if available
    const additionalData = {};
    
    if (event.s3Keys?.ticketingData) {
      additionalData.ticketingData = await s3Service.getJson(event.s3Keys.ticketingData);
    }
    
    if (event.s3Keys?.seatingChart) {
      additionalData.seatingChart = await s3Service.getJson(event.s3Keys.seatingChart);
    }

    res.status(200).json({
      success: true,
      data: {
        ...event,
        ...additionalData
      }
    });

  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error retrieving event', { eventId, error: error.message });
    throw new AppError('Failed to retrieve event', 500, error.message);
  }
}));

/**
 * GET /events
 * Lists all events with pagination
 */
router.get('/', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 100); // Max 100 items per page
  const offset = (page - 1) * limit;

  logger.info('Listing events', { page, limit });

  try {
    const { events, total } = await rdsService.getEvents(limit, offset);

    res.status(200).json({
      success: true,
      data: {
        events,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });

  } catch (error) {
    logger.error('Error listing events', { error: error.message });
    throw new AppError('Failed to retrieve events', 500, error.message);
  }
}));

/**
 * PUT /events/:eventId
 * Updates an existing event
 */
router.put('/:eventId', validateCreateEvent, asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  if (!eventId || !eventId.startsWith('evt_')) {
    throw new AppError('Invalid event ID format', 400);
  }

  // Check for validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError('Validation failed', 400, errors.array());
  }

  logger.info('Updating event', { eventId });

  try {
    // Check if event exists
    const existingEvent = await rdsService.getEventById(eventId);
    if (!existingEvent) {
      throw new AppError('Event not found', 404);
    }

    const {
      name,
      description,
      venue,
      expectedAttendees,
      eventDate,
      eventType,
      ticketingData,
      seatingChart
    } = req.body;

    // Handle S3 updates
    const s3Keys = { ...existingEvent.s3Keys };

    if (ticketingData) {
      const ticketingKey = `events/${eventId}/ticketing-data.json`;
      await s3Service.uploadJson(ticketingKey, ticketingData);
      s3Keys.ticketingData = ticketingKey;
    }

    if (seatingChart) {
      const seatingKey = `events/${eventId}/seating-chart.json`;
      await s3Service.uploadJson(seatingKey, seatingChart);
      s3Keys.seatingChart = seatingKey;
    }

    // Update event in RDS
    const updateData = {
      name,
      description,
      venue,
      expectedAttendees,
      eventDate: new Date(eventDate),
      eventType,
      s3Keys,
      updatedAt: new Date()
    };

    const updatedEvent = await rdsService.updateEvent(eventId, updateData);

    logger.info('Event updated successfully', { eventId });

    res.status(200).json({
      success: true,
      data: updatedEvent,
      message: 'Event updated successfully'
    });

  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error updating event', { eventId, error: error.message });
    throw new AppError('Failed to update event', 500, error.message);
  }
}));

/**
 * DELETE /events/:eventId
 * Deletes an event and associated data
 */
router.delete('/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  if (!eventId || !eventId.startsWith('evt_')) {
    throw new AppError('Invalid event ID format', 400);
  }

  logger.info('Deleting event', { eventId });

  try {
    // Get event to find associated S3 keys
    const event = await rdsService.getEventById(eventId);
    if (!event) {
      throw new AppError('Event not found', 404);
    }

    // Delete S3 objects
    if (event.s3Keys && Object.keys(event.s3Keys).length > 0) {
      await s3Service.deleteObjects(Object.values(event.s3Keys));
    }

    // Delete event from RDS
    await rdsService.deleteEvent(eventId);

    logger.info('Event deleted successfully', { eventId });

    res.status(200).json({
      success: true,
      message: 'Event deleted successfully'
    });

  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error deleting event', { eventId, error: error.message });
    throw new AppError('Failed to delete event', 500, error.message);
  }
}));

module.exports = router;

