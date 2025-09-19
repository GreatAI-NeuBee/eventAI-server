const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');

const userService = require('../services/userService');
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
  defaultMeta: { service: 'user-controller' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Validation middleware for creating users
const validateCreateUser = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('username')
    .optional()
    .isString()
    .isLength({ min: 3, max: 255 })
    .withMessage('Username must be 3-255 characters'),
  body('status')
    .optional()
    .isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING'])
    .withMessage('Status must be one of: ACTIVE, INACTIVE, SUSPENDED, PENDING'),
  body('phone')
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Phone must be a valid international format')
];

// Validation middleware for updating users
const validateUpdateUser = [
  body('email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('username')
    .optional()
    .isString()
    .isLength({ min: 3, max: 255 })
    .withMessage('Username must be 3-255 characters'),
  body('status')
    .optional()
    .isIn(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING'])
    .withMessage('Status must be one of: ACTIVE, INACTIVE, SUSPENDED, PENDING'),
  body('phone')
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Phone must be a valid international format')
];

/**
 * POST /users
 * Creates a new user
 */
router.post('/', validateCreateUser, asyncHandler(async (req, res) => {
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

  const {
    email,
    username,
    status,
    phone
  } = req.body;

  // Generate unique user ID
  const userId = `usr_${uuidv4()}`;

  logger.info('Creating new user', { userId, email, username });

  try {
    const userData = {
      userId,
      email,
      username,
      status,
      phone
    };

    const user = await userService.createUser(userData);

    logger.info('User created successfully', { userId, email });

    res.status(201).json({
      success: true,
      data: user,
      message: 'User created successfully'
    });

  } catch (error) {
    logger.error('Error creating user', { userId, email, error: error.message });
    
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
    
    throw new AppError('Failed to create user', 500, error.message);
  }
}));

/**
 * GET /users
 * Retrieves all users with pagination and filtering
 */
router.get('/', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 100); // Max 100 per page
  const offset = (page - 1) * limit;

  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.search) filters.search = req.query.search;

  logger.info('Retrieving users', { page, limit, filters });

  try {
    const result = await userService.getUsers(limit, offset, filters);

    const totalPages = Math.ceil(result.total / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    res.status(200).json({
      success: true,
      data: {
        users: result.users,
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
    logger.error('Error retrieving users', { error: error.message });
    throw new AppError('Failed to retrieve users', 500, error.message);
  }
}));

/**
 * GET /users/statistics
 * Retrieves user statistics
 */
router.get('/statistics', asyncHandler(async (req, res) => {
  logger.info('Retrieving user statistics');

  try {
    const statistics = await userService.getUserStatistics();

    res.status(200).json({
      success: true,
      data: statistics
    });

  } catch (error) {
    logger.error('Error retrieving user statistics', { error: error.message });
    throw new AppError('Failed to retrieve user statistics', 500, error.message);
  }
}));

/**
 * GET /users/email/:email
 * Retrieves a user by email
 */
router.get('/email/:email', asyncHandler(async (req, res) => {
  const { email } = req.params;

  logger.info('Retrieving user by email', { email });

  try {
    const user = await userService.getUserByEmail(email);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: {
          status: 'fail',
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    res.status(200).json({
      success: true,
      data: user
    });

  } catch (error) {
    logger.error('Error retrieving user by email', { email, error: error.message });
    throw new AppError('Failed to retrieve user', 500, error.message);
  }
}));

/**
 * GET /users/username/:username
 * Retrieves a user by username
 */
router.get('/username/:username', asyncHandler(async (req, res) => {
  const { username } = req.params;

  logger.info('Retrieving user by username', { username });

  try {
    const user = await userService.getUserByUsername(username);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: {
          status: 'fail',
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    res.status(200).json({
      success: true,
      data: user
    });

  } catch (error) {
    logger.error('Error retrieving user by username', { username, error: error.message });
    throw new AppError('Failed to retrieve user', 500, error.message);
  }
}));

/**
 * GET /users/:userId
 * Retrieves a specific user by ID
 */
router.get('/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;

  logger.info('Retrieving user by ID', { userId });

  try {
    const user = await userService.getUserById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: {
          status: 'fail',
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    res.status(200).json({
      success: true,
      data: user
    });

  } catch (error) {
    logger.error('Error retrieving user', { userId, error: error.message });
    throw new AppError('Failed to retrieve user', 500, error.message);
  }
}));

/**
 * PUT /users/:userId
 * Updates an existing user
 */
router.put('/:userId', validateUpdateUser, asyncHandler(async (req, res) => {
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

  const { userId } = req.params;
  const updateData = req.body;

  logger.info('Updating user', { userId });

  try {
    // Check if user exists
    const existingUser = await userService.getUserById(userId);
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        error: {
          status: 'fail',
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    const updatedUser = await userService.updateUser(userId, updateData);

    logger.info('User updated successfully', { userId });

    res.status(200).json({
      success: true,
      data: updatedUser,
      message: 'User updated successfully'
    });

  } catch (error) {
    logger.error('Error updating user', { userId, error: error.message });
    
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
    
    throw new AppError('Failed to update user', 500, error.message);
  }
}));

/**
 * DELETE /users/:userId
 * Deletes a user
 */
router.delete('/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;

  logger.info('Deleting user', { userId });

  try {
    // Check if user exists
    const existingUser = await userService.getUserById(userId);
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        error: {
          status: 'fail',
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    await userService.deleteUser(userId);

    logger.info('User deleted successfully', { userId });

    res.status(200).json({
      success: true,
      message: 'User deleted successfully'
    });

  } catch (error) {
    logger.error('Error deleting user', { userId, error: error.message });
    throw new AppError('Failed to delete user', 500, error.message);
  }
}));


module.exports = router;
