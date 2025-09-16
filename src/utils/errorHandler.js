const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'error-handler' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

/**
 * Custom Application Error class
 */
class AppError extends Error {
  constructor(message, statusCode, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true;
    this.details = details;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Async handler wrapper to catch errors in async functions
 * @param {Function} fn - Async function to wrap
 * @returns {Function} - Wrapped function
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Development error response
 * @param {Error} err - Error object
 * @param {Object} res - Express response object
 */
const sendErrorDev = (err, res) => {
  res.status(err.statusCode).json({
    success: false,
    error: {
      status: err.status,
      message: err.message,
      details: err.details,
      stack: err.stack
    },
    timestamp: new Date().toISOString(),
    requestId: res.locals.requestId
  });
};

/**
 * Production error response
 * @param {Error} err - Error object
 * @param {Object} res - Express response object
 */
const sendErrorProd = (err, res) => {
  // Operational, trusted error: send message to client
  if (err.isOperational) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        status: err.status,
        message: err.message,
        details: err.details
      },
      timestamp: new Date().toISOString(),
      requestId: res.locals.requestId
    });
  } else {
    // Programming or other unknown error: don't leak error details
    logger.error('Programming Error:', err);

    res.status(500).json({
      success: false,
      error: {
        status: 'error',
        message: 'Something went wrong on our end. Please try again later.',
        code: 'INTERNAL_SERVER_ERROR'
      },
      timestamp: new Date().toISOString(),
      requestId: res.locals.requestId
    });
  }
};

/**
 * Handle AWS SDK errors
 * @param {Error} err - AWS SDK error
 * @returns {AppError} - Formatted AppError
 */
const handleAWSError = (err) => {
  let message = 'AWS service error occurred';
  let statusCode = 500;

  if (err.name === 'NoSuchBucket') {
    message = 'Storage bucket not found';
    statusCode = 404;
  } else if (err.name === 'AccessDenied') {
    message = 'Insufficient permissions for AWS operation';
    statusCode = 403;
  } else if (err.name === 'InvalidParameterValue') {
    message = 'Invalid parameter provided to AWS service';
    statusCode = 400;
  } else if (err.name === 'ThrottlingException') {
    message = 'AWS service rate limit exceeded. Please try again later.';
    statusCode = 429;
  } else if (err.name === 'ServiceUnavailable') {
    message = 'AWS service temporarily unavailable';
    statusCode = 503;
  }

  return new AppError(message, statusCode, {
    awsError: err.name,
    awsMessage: err.message,
    awsCode: err.code
  });
};

/**
 * Handle Prisma/Database errors
 * @param {Error} err - Prisma error
 * @returns {AppError} - Formatted AppError
 */
const handleDatabaseError = (err) => {
  let message = 'Database operation failed';
  let statusCode = 500;

  if (err.code === 'P2002') {
    // Unique constraint violation
    const field = err.meta?.target?.[0] || 'field';
    message = `A record with this ${field} already exists`;
    statusCode = 409;
  } else if (err.code === 'P2025') {
    // Record not found
    message = 'Record not found';
    statusCode = 404;
  } else if (err.code === 'P2003') {
    // Foreign key constraint violation
    message = 'Cannot delete record due to existing relationships';
    statusCode = 409;
  } else if (err.code === 'P2021') {
    // Table does not exist
    message = 'Database table not found';
    statusCode = 500;
  } else if (err.code === 'P1001') {
    // Database connection error
    message = 'Cannot connect to database';
    statusCode = 503;
  }

  return new AppError(message, statusCode, {
    prismaError: err.code,
    prismaMessage: err.message,
    meta: err.meta
  });
};

/**
 * Handle JSON Web Token errors
 * @param {Error} err - JWT error
 * @returns {AppError} - Formatted AppError
 */
const handleJWTError = (err) => {
  let message = 'Authentication failed';
  let statusCode = 401;

  if (err.name === 'JsonWebTokenError') {
    message = 'Invalid authentication token';
  } else if (err.name === 'TokenExpiredError') {
    message = 'Authentication token has expired';
  } else if (err.name === 'NotBeforeError') {
    message = 'Authentication token not active yet';
  }

  return new AppError(message, statusCode, {
    jwtError: err.name,
    jwtMessage: err.message
  });
};

/**
 * Handle validation errors
 * @param {Error} err - Validation error
 * @returns {AppError} - Formatted AppError
 */
const handleValidationError = (err) => {
  const errors = err.errors || [];
  const message = errors.length > 0 ? errors[0].msg : 'Validation failed';
  
  return new AppError(message, 400, {
    validationErrors: errors
  });
};

/**
 * Handle cast errors (invalid IDs, etc.)
 * @param {Error} err - Cast error
 * @returns {AppError} - Formatted AppError
 */
const handleCastError = (err) => {
  const message = `Invalid ${err.path}: ${err.value}`;
  return new AppError(message, 400);
};

/**
 * Handle duplicate field errors
 * @param {Error} err - Duplicate field error
 * @returns {AppError} - Formatted AppError
 */
const handleDuplicateFieldsError = (err) => {
  const value = err.errmsg.match(/(["'])(\\?.)*?\1/)[0];
  const message = `Duplicate field value: ${value}. Please use another value!`;
  return new AppError(message, 400);
};

/**
 * Global error handling middleware
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const globalErrorHandler = (err, req, res, next) => {
  // Set default values
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  // Generate request ID if not present
  if (!res.locals.requestId) {
    res.locals.requestId = require('uuid').v4();
  }

  // Log error with context
  logger.error('Global Error Handler', {
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack,
      statusCode: err.statusCode
    },
    request: {
      id: res.locals.requestId,
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    }
  });

  let error = { ...err };
  error.message = err.message;

  // Handle specific error types
  if (err.name === 'CastError') error = handleCastError(error);
  if (err.code === 11000) error = handleDuplicateFieldsError(error);
  if (err.name === 'ValidationError') error = handleValidationError(error);
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.name === 'NotBeforeError') {
    error = handleJWTError(error);
  }
  
  // Handle AWS SDK errors
  if (err.$metadata || err.name?.includes('AWS') || err.code?.startsWith('AWS')) {
    error = handleAWSError(error);
  }
  
  // Handle Prisma/Database errors
  if (err.code?.startsWith('P') || err.name === 'PrismaClientKnownRequestError') {
    error = handleDatabaseError(error);
  }

  // Send error response based on environment
  if (process.env.NODE_ENV === 'development') {
    sendErrorDev(error, res);
  } else {
    sendErrorProd(error, res);
  }
};

/**
 * Handle 404 errors for undefined routes
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const handle404 = (req, res, next) => {
  const err = new AppError(`Can't find ${req.originalUrl} on this server!`, 404);
  next(err);
};

/**
 * Request ID middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const requestIdMiddleware = (req, res, next) => {
  const requestId = req.headers['x-request-id'] || require('uuid').v4();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
};

/**
 * Security headers middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const securityHeaders = (req, res, next) => {
  // Remove sensitive headers
  res.removeHeader('X-Powered-By');
  
  // Add security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  next();
};

/**
 * Request timeout middleware
 * @param {number} timeout - Timeout in milliseconds (default: 30000)
 * @returns {Function} - Middleware function
 */
const requestTimeout = (timeout = 30000) => {
  return (req, res, next) => {
    const timeoutId = setTimeout(() => {
      if (!res.headersSent) {
        const err = new AppError('Request timeout', 408);
        next(err);
      }
    }, timeout);

    res.on('finish', () => {
      clearTimeout(timeoutId);
    });

    res.on('close', () => {
      clearTimeout(timeoutId);
    });

    next();
  };
};

module.exports = {
  AppError,
  asyncHandler,
  globalErrorHandler,
  handle404,
  requestIdMiddleware,
  securityHeaders,
  requestTimeout,
  handleAWSError,
  handleDatabaseError,
  handleJWTError,
  handleValidationError
};

