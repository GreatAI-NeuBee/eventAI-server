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

// Validation middleware for updating events with attachment support
const validateUpdateEvent = [
  body('name')
    .optional()
    .isString()
    .isLength({ min: 1, max: 255 })
    .withMessage('Event name must be between 1 and 255 characters'),
  body('description')
    .optional()
    .isString()
    .isLength({ max: 1000 })
    .withMessage('Description must not exceed 1000 characters'),
  body('venue')
    .optional()
    .isString()
    .isLength({ min: 1, max: 255 })
    .withMessage('Venue must be between 1 and 255 characters'),
  body('dateOfEventStart')
    .optional()
    .isISO8601()
    .withMessage('Event start date must be a valid ISO 8601 date'),
  body('dateOfEventEnd')
    .optional()
    .isISO8601()
    .withMessage('Event end date must be a valid ISO 8601 date'),
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
    .withMessage('User email must be a valid email address'),
  body('attachmentUrls')
    .optional()
    .isArray()
    .withMessage('Attachment URLs must be an array')
    .custom((urls) => {
      if (!Array.isArray(urls)) return false;
      // Validate each URL in the array
      for (const url of urls) {
        if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
          throw new Error('Each attachment URL must be a non-empty string with max 2048 characters');
        }
        // Basic URL validation
        try {
          new URL(url);
        } catch {
          throw new Error(`Invalid URL format: ${url}`);
        }
      }
      return true;
    }),
  body('attachmentContext')
    .optional()
    .isString()
    .isLength({ max: 10000 })
    .withMessage('Attachment context must not exceed 10,000 characters')
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
 * Updates an existing event with attachment support
 */
router.put('/:eventId', validateUpdateEvent, asyncHandler(async (req, res) => {
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
      dateOfEventStart,
      dateOfEventEnd,
      status,
      venueLayout,
      userEmail,
      attachmentUrls,
      attachmentContext
    } = req.body;

    // Validate attachment URLs if provided
    if (attachmentUrls && Array.isArray(attachmentUrls)) {
      for (const url of attachmentUrls) {
        try {
          new URL(url); // Validate URL format
        } catch (error) {
          throw new AppError(`Invalid URL format: ${url}`, 400);
        }
      }
    }

    // Update event in database
    const updateData = {};
    
    // Only include fields that are provided in the request
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (venue !== undefined) updateData.venue = venue;
    if (dateOfEventStart !== undefined) updateData.dateOfEventStart = new Date(dateOfEventStart);
    if (dateOfEventEnd !== undefined) updateData.dateOfEventEnd = new Date(dateOfEventEnd);
    if (status !== undefined) updateData.status = status;
    if (venueLayout !== undefined) updateData.venueLayout = venueLayout;
    if (userEmail !== undefined) updateData.userEmail = userEmail;
    if (attachmentUrls !== undefined) updateData.attachmentUrls = attachmentUrls;
    if (attachmentContext !== undefined) updateData.attachmentContext = attachmentContext;

    // Ensure at least one field is being updated
    if (Object.keys(updateData).length === 0) {
      throw new AppError('No valid fields provided for update', 400);
    }

    const updatedEvent = await supabaseService.updateEvent(eventId, updateData);

    logger.info('Event updated successfully', { 
      eventId, 
      updatedFields: Object.keys(updateData),
      hasAttachments: !!(attachmentUrls && attachmentUrls.length > 0)
    });

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

