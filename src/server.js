const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const swaggerJSDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Import controllers
const eventController = require('./controllers/eventController');
const simulationController = require('./controllers/simulationController');

// Import middleware
const errorHandler = require('./utils/errorHandler');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'event-ai-server' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    }),
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: 'logs/combined.log',
      maxsize: 10485760, // 10MB
      maxFiles: 5
    })
  ]
});

// Initialize Express app
const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.RATE_LIMIT || 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    requestId: req.headers['x-request-id'] || 'unknown'
  });
  next();
});

// Swagger/OpenAPI Documentation
const swaggerDocument = YAML.load(path.join(__dirname, '..', 'docs', 'openapi.yaml'));

// Update servers in swagger document based on environment
if (process.env.NODE_ENV === 'production') {
  swaggerDocument.servers = [
    { url: process.env.API_BASE_URL || 'https://your-domain.com', description: 'Production server' },
    { url: 'http://localhost:3000', description: 'Local development server' }
  ];
} else {
  swaggerDocument.servers = [
    { url: 'http://localhost:3000', description: 'Local development server' },
    { url: 'https://your-domain.com', description: 'Production server' }
  ];
}

// Swagger UI options
const swaggerOptions = {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Event AI API Documentation',
  customfavIcon: '/favicon.ico',
  swaggerOptions: {
    docExpansion: 'list',
    filter: true,
    showRequestHeaders: true,
    showCommonExtensions: true,
    tryItOutEnabled: true
  }
};

// Serve API documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, swaggerOptions));

// API documentation redirect
app.get('/docs', (req, res) => {
  res.redirect('/api-docs');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    documentation: {
      swagger: `${req.protocol}://${req.get('host')}/api-docs`,
      openapi: `${req.protocol}://${req.get('host')}/api-docs.json`
    }
  });
});

// Serve OpenAPI JSON
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerDocument);
});

// Serve Postman Guide
app.get('/postman-guide', (req, res) => {
  try {
    const postmanGuidePath = path.join(__dirname, '..', 'PostmanGuide.md');
    const postmanGuide = fs.readFileSync(postmanGuidePath, 'utf8');
    
    res.setHeader('Content-Type', 'text/markdown');
    res.send(postmanGuide);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Postman guide not found',
      message: 'The Postman guide file could not be loaded'
    });
  }
});

// API routes
app.use('/api/v1/events', eventController);
app.use('/api/v1/simulations', simulationController);

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Event AI Server',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    documentation: {
      swagger: `${req.protocol}://${req.get('host')}/api-docs`,
      openapi: `${req.protocol}://${req.get('host')}/api-docs.json`,
      postman: `${req.protocol}://${req.get('host')}/postman-guide`
    },
    endpoints: {
      health: `${req.protocol}://${req.get('host')}/health`,
      events: `${req.protocol}://${req.get('host')}/api/v1/events`,
      simulations: `${req.protocol}://${req.get('host')}/api/v1/simulations`
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Global error handler
app.use(errorHandler.globalErrorHandler);

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Event AI Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Health check available at: http://localhost:${PORT}/health`);
  
  // Test database connection on startup
  if (process.env.SUPABASE_URL) {
    const supabaseService = require('./services/supabaseService');
    supabaseService.testConnection()
      .then(connected => {
        if (connected) {
          logger.info('✅ Supabase connection successful');
        } else {
          logger.error('❌ Supabase connection failed');
        }
      })
      .catch(error => {
        logger.error('❌ Supabase connection error:', error.message);
      });
  }
});

module.exports = app;
