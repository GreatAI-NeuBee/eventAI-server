const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const multer = require('multer');

const s3Service = require('../services/s3Service');
const supabaseService = require('../services/supabaseService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 2 // Max 2 files (ticketingData + seatingChart)
  },
  fileFilter: (req, file, cb) => {
    // Allow CSV for ticketing data and JSON for seating chart
    const allowedMimes = ['text/csv', 'application/json', 'text/plain'];
    if (allowedMimes.includes(file.mimetype) || file.mimetype.startsWith('text/')) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Only CSV and JSON files are allowed.`), false);
    }
  }
});

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

// Custom validation middleware for multipart form data
const validateMultipartEventData = (req, res, next) => {
  const errors = [];
  
  // Extract form fields
  const { name, description, venue, expectedAttendees, eventDate, eventType } = req.body;
  
  // Validate name
  if (!name || typeof name !== 'string') {
    errors.push({
      type: 'field',
      msg: 'Event name is required',
      path: 'name',
      location: 'body'
    });
  } else if (name.length < 1 || name.length > 255) {
    errors.push({
      type: 'field',
      msg: 'Event name must be between 1 and 255 characters',
      path: 'name',
      location: 'body'
    });
  }
  
  // Validate description (optional)
  if (description && (typeof description !== 'string' || description.length > 1000)) {
    errors.push({
      type: 'field',
      msg: 'Description must not exceed 1000 characters',
      path: 'description',
      location: 'body'
    });
  }
  
  // Validate venue
  if (!venue || typeof venue !== 'string') {
    errors.push({
      type: 'field',
      msg: 'Venue is required',
      path: 'venue',
      location: 'body'
    });
  } else if (venue.length < 1 || venue.length > 255) {
    errors.push({
      type: 'field',
      msg: 'Venue must be between 1 and 255 characters',
      path: 'venue',
      location: 'body'
    });
  }
  
  // Validate expectedAttendees
  const attendees = parseInt(expectedAttendees);
  if (!expectedAttendees || isNaN(attendees)) {
    errors.push({
      type: 'field',
      msg: 'Expected attendees is required and must be a number',
      path: 'expectedAttendees',
      location: 'body'
    });
  } else if (attendees < 1 || attendees > 100000) {
    errors.push({
      type: 'field',
      msg: 'Expected attendees must be between 1 and 100,000',
      path: 'expectedAttendees',
      location: 'body'
    });
  } else {
    // Convert to integer for processing
    req.body.expectedAttendees = attendees;
  }
  
  // Validate eventDate
  if (!eventDate) {
    errors.push({
      type: 'field',
      msg: 'Event date is required',
      path: 'eventDate',
      location: 'body'
    });
  } else {
    const date = new Date(eventDate);
    if (isNaN(date.getTime())) {
      errors.push({
        type: 'field',
        msg: 'Event date must be a valid ISO 8601 date',
        path: 'eventDate',
        location: 'body'
      });
    }
  }
  
  // Validate eventType
  const validTypes = ['CONCERT', 'CONFERENCE', 'SPORTS', 'FESTIVAL', 'OTHER'];
  if (!eventType) {
    errors.push({
      type: 'field',
      msg: 'Event type is required',
      path: 'eventType',
      location: 'body'
    });
  } else if (!validTypes.includes(eventType.toUpperCase())) {
    errors.push({
      type: 'field',
      msg: 'Event type must be one of: CONCERT, CONFERENCE, SPORTS, FESTIVAL, OTHER',
      path: 'eventType',
      location: 'body'
    });
  } else {
    // Normalize to uppercase
    req.body.eventType = eventType.toUpperCase();
  }
  
  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: {
        status: 'fail',
        message: 'Validation failed',
        details: errors
      },
      timestamp: new Date().toISOString(),
      requestId: req.headers['x-request-id'] || 'unknown'
    });
  }
  
  next();
};

// Validation middleware for JSON requests (backward compatibility)
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
    .isIn(['CONCERT', 'CONFERENCE', 'SPORTS', 'FESTIVAL', 'OTHER'])
    .withMessage('Event type must be one of: CONCERT, CONFERENCE, SPORTS, FESTIVAL, OTHER')
];

/**
 * POST /events
 * Creates a new event with optional file uploads
 */
router.post('/', upload.fields([
  { name: 'ticketingData', maxCount: 1 },
  { name: 'seatingChart', maxCount: 1 }
]), (req, res, next) => {
  // Check if this is a multipart request
  const isMultipart = req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data');
  
  if (isMultipart) {
    // Use multipart validation
    validateMultipartEventData(req, res, next);
  } else {
    // Use JSON validation
    validateCreateEvent.forEach(validator => validator(req, res, () => {}));
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
    next();
  }
}, asyncHandler(async (req, res) => {

  const {
    name,
    description,
    venue,
    expectedAttendees,
    eventDate,
    eventType
  } = req.body;

  // Generate unique IDs
  const eventId = `evt_${uuidv4()}`;
  const simulationId = `sim_${uuidv4()}`;

  logger.info('Creating new event', { eventId, name, venue });

  try {
    // Prepare S3 upload promises for datasets
    const uploadPromises = [];
    const s3Keys = {};

    // Handle file uploads from multer
    if (req.files) {
      // Upload ticketing data to S3 if provided
      if (req.files.ticketingData && req.files.ticketingData[0]) {
        const ticketingFile = req.files.ticketingData[0];
        const ticketingKey = `events/${eventId}/ticketing-data.${ticketingFile.mimetype === 'text/csv' ? 'csv' : 'json'}`;
        
        logger.info('Uploading ticketing data', { eventId, filename: ticketingFile.originalname, size: ticketingFile.size });
        
        uploadPromises.push(
          s3Service.uploadFile(ticketingKey, ticketingFile.buffer, ticketingFile.mimetype)
            .then(() => { 
              s3Keys.ticketingData = ticketingKey;
              logger.info('Ticketing data uploaded successfully', { eventId, key: ticketingKey });
            })
        );
      }

      // Upload seating chart to S3 if provided
      if (req.files.seatingChart && req.files.seatingChart[0]) {
        const seatingFile = req.files.seatingChart[0];
        const seatingKey = `events/${eventId}/seating-chart.${seatingFile.mimetype === 'application/json' ? 'json' : 'txt'}`;
        
        logger.info('Uploading seating chart', { eventId, filename: seatingFile.originalname, size: seatingFile.size });
        
        uploadPromises.push(
          s3Service.uploadFile(seatingKey, seatingFile.buffer, seatingFile.mimetype)
            .then(() => { 
              s3Keys.seatingChart = seatingKey;
              logger.info('Seating chart uploaded successfully', { eventId, key: seatingKey });
            })
        );
      }
    }

    // Wait for all S3 uploads to complete
    if (uploadPromises.length > 0) {
      await Promise.all(uploadPromises);
    }

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

    await supabaseService.createEvent(eventData);

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
    const event = await supabaseService.getEventById(eventId);

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
    const { events, total } = await supabaseService.getEvents(limit, offset);

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
    const existingEvent = await supabaseService.getEventById(eventId);
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

    const updatedEvent = await supabaseService.updateEvent(eventId, updateData);

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
    const event = await supabaseService.getEventById(eventId);
    if (!event) {
      throw new AppError('Event not found', 404);
    }

    // Delete S3 objects
    if (event.s3Keys && Object.keys(event.s3Keys).length > 0) {
      await s3Service.deleteObjects(Object.values(event.s3Keys));
    }

    // Delete event from RDS
    await supabaseService.deleteEvent(eventId);

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

