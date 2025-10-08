const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
// const rateLimit = require('express-rate-limit'); // DISABLED - Rate limiting removed
const winston = require('winston');
const swaggerJSDoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Import controllers
const eventController = require('./controllers/newEventController');
const forecastController = require('./controllers/forecastController');
const userController = require('./controllers/userController');
const predictionController = require('./controllers/predictionController');

// Import middleware
const errorHandler = require('./utils/errorHandler');

// Import services
const cronService = require('./services/cronService');

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
      styleSrc: ["'self'", "'unsafe-inline'", "data:", "https://unpkg.com"],
      styleSrcElem: ["'self'", "'unsafe-inline'", "data:", "https://unpkg.com"], // Explicitly allow external stylesheets
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com"],
      scriptSrcElem: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com"], // Explicitly allow external scripts
      imgSrc: ["'self'", "data:", "https:", "http:"],
      fontSrc: ["'self'", "data:", "https://unpkg.com"], // Allow fonts from unpkg
      connectSrc: ["'self'", "http:", "https:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration for EC2 deployment
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    // Allow localhost and EC2 instances
    if (origin.includes('localhost') || 
        origin.includes('127.0.0.1') || 
        origin.includes('43.216.157.151') ||
        (process.env.ALLOWED_ORIGINS && process.env.ALLOWED_ORIGINS.split(',').includes(origin))) {
      return callback(null, true);
    }
    
    // For development, allow all origins
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

// Rate limiting - DISABLED
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: process.env.RATE_LIMIT || 100, // limit each IP to 100 requests per windowMs
//   message: {
//     error: 'Too many requests from this IP, please try again later.',
//     retryAfter: '15 minutes'
//   },
//   standardHeaders: true,
//   legacyHeaders: false
// });
// app.use(limiter);

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
const getServerUrl = (req) => {
  if (req && req.headers.host) {
    // Check multiple headers for HTTPS detection
    const proto = req.headers['x-forwarded-proto'] || 
                  req.headers['x-forwarded-protocol'] ||
                  req.headers['x-url-scheme'] ||
                  (req.connection.encrypted ? 'https' : 'http');
    
    // Force HTTPS for production domains
    const host = req.headers.host;
    const isProduction = host.includes('munymunyhom.tech') || 
                        host.includes('eventbuddy-api') ||
                        process.env.NODE_ENV === 'production';
    
    const protocol = isProduction ? 'https' : proto;
    
    return `${protocol}://${host}`;
  }
  return process.env.API_BASE_URL || 'http://localhost:3000';
};

// Dynamic server configuration
const configureSwaggerServers = (req) => {
  const currentServerUrl = getServerUrl(req);
  
  if (process.env.NODE_ENV === 'production') {
    return [
      { url: currentServerUrl, description: 'Current server' },
      { url: 'http://localhost:3000', description: 'Local development server' }
    ];
  } else {
    return [
      { url: 'http://localhost:3000', description: 'Local development server' },
      { url: currentServerUrl, description: 'Current server' }
    ];
  }
};

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
    tryItOutEnabled: true,
    supportedSubmitMethods: ['get', 'post', 'put', 'delete', 'patch'],
    defaultModelsExpandDepth: 1,
    defaultModelExpandDepth: 1
  },
  // Fix for EC2 deployment - serve assets locally
  swaggerUrl: undefined,
  explorer: false,
  customCssUrl: undefined
};

// Custom Swagger UI with dynamic protocol detection
app.get('/api-docs', (req, res, next) => {
  // Disable CSP for this endpoint to allow external resources
  res.setHeader('Content-Security-Policy', '');
  next();
}, (req, res) => {
  const serverUrl = getServerUrl(req);
  const dynamicSwaggerDocument = { 
    ...swaggerDocument, 
    servers: configureSwaggerServers(req) 
  };
  
  // Create custom HTML for Swagger UI
  const customSwaggerHTML = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Event AI API Documentation</title>
      <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui.css" />
      <style>
        html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
        *, *:before, *:after { box-sizing: inherit; }
        body { margin:0; background: #fafafa; }
        .swagger-ui .topbar { display: none; }
      </style>
    </head>
    <body>
      <div id="swagger-ui"></div>
      <script src="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui-bundle.js"></script>
      <script src="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui-standalone-preset.js"></script>
      <script>
        // Add loading indicator
        document.body.innerHTML = '<div style="text-align:center;padding:50px;font-family:Arial,sans-serif;"><h2>Loading Swagger UI...</h2><p>If this takes too long, try <a href="${serverUrl}/api-docs-simple">Simple API Documentation</a></p></div>' + document.body.innerHTML;
        
        window.onload = function() {
          try {
            if (typeof SwaggerUIBundle === 'undefined') {
              throw new Error('SwaggerUIBundle not loaded');
            }
            
            const ui = SwaggerUIBundle({
              url: '${serverUrl}/api-docs.json',
              dom_id: '#swagger-ui',
              deepLinking: true,
              presets: [
                SwaggerUIBundle.presets.apis,
                SwaggerUIStandalonePreset
              ],
              plugins: [
                SwaggerUIBundle.plugins.DownloadUrl
              ],
              layout: "StandaloneLayout",
              validatorUrl: null,
              requestInterceptor: function(request) {
                if (request.url.startsWith('https://43.216.157.151')) {
                  request.url = request.url.replace('https://', 'http://');
                }
                return request;
              },
              supportedSubmitMethods: ['get', 'post', 'put', 'delete', 'patch'],
              tryItOutEnabled: true,
              filter: true,
              showRequestHeaders: true,
              onComplete: function() {
                // Remove loading indicator
                const loading = document.querySelector('div[style*="Loading Swagger UI"]');
                if (loading) loading.remove();
              }
            });
          } catch (error) {
            console.error('Swagger UI failed to load:', error);
            document.body.innerHTML = '<div style="text-align:center;padding:50px;font-family:Arial,sans-serif;color:red;"><h2>Failed to load Swagger UI</h2><p>External resources could not be loaded. Please use <a href="${serverUrl}/api-docs-simple">Simple API Documentation</a> instead.</p><p>Error: ' + error.message + '</p></div>';
          }
        };
        
        // Fallback timeout
        setTimeout(function() {
          if (document.querySelector('div[style*="Loading Swagger UI"]')) {
            document.body.innerHTML = '<div style="text-align:center;padding:50px;font-family:Arial,sans-serif;color:orange;"><h2>Swagger UI Loading Timeout</h2><p>External resources are taking too long to load. Please use <a href="${serverUrl}/api-docs-simple">Simple API Documentation</a> instead.</p></div>';
          }
        }, 10000);
      </script>
    </body>
    </html>
  `;
  
  res.send(customSwaggerHTML);
});

// API documentation redirect
app.get('/docs', (req, res) => {
  res.redirect('/api-docs');
});

// Simple API documentation fallback for EC2
app.get('/api-docs-simple', (req, res) => {
  const serverUrl = getServerUrl(req);
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Event AI API Documentation</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
        h1, h2 { color: #333; }
        .endpoint { background: #f4f4f4; padding: 15px; margin: 10px 0; border-left: 4px solid #007cba; }
        .method { font-weight: bold; color: #fff; padding: 4px 8px; border-radius: 3px; }
        .get { background: #61affe; }
        .post { background: #49cc90; }
        .put { background: #fca130; }
        .delete { background: #f93e3e; }
        code { background: #f1f1f1; padding: 2px 4px; border-radius: 3px; }
      </style>
    </head>
    <body>
      <h1>🚀 Event AI Server API Documentation</h1>
      <p><strong>Server:</strong> ${serverUrl}</p>
      <p><strong>Version:</strong> 1.0.0</p>
      
      <h2>📋 Quick Links</h2>
      <ul>
        <li><a href="${serverUrl}/health">Health Check</a></li>
        <li><a href="${serverUrl}/api-docs.json">OpenAPI JSON</a></li>
        <li><a href="${serverUrl}/postman-guide">Postman Guide</a></li>
        <li><a href="${serverUrl}/api-docs">Full Swagger UI</a> (if supported)</li>
      </ul>
      
      <h2>🔗 API Endpoints</h2>
      
      <div class="endpoint">
        <span class="method get">GET</span> <code>/health</code>
        <p>Server health check and metrics</p>
      </div>
      
      <h3>👥 User Management</h3>
      
      <div class="endpoint">
        <span class="method post">POST</span> <code>/api/v1/users</code>
        <p>Create a new user account</p>
      </div>
      
      <div class="endpoint">
        <span class="method get">GET</span> <code>/api/v1/users</code>
        <p>List all users (paginated, with filtering)</p>
      </div>
      
      <div class="endpoint">
        <span class="method get">GET</span> <code>/api/v1/users/{userId}</code>
        <p>Get specific user by ID</p>
      </div>
      
      <div class="endpoint">
        <span class="method put">PUT</span> <code>/api/v1/users/{userId}</code>
        <p>Update existing user</p>
      </div>
      
      <div class="endpoint">
        <span class="method delete">DELETE</span> <code>/api/v1/users/{userId}</code>
        <p>Delete user account</p>
      </div>
      
      <div class="endpoint">
        <span class="method get">GET</span> <code>/api/v1/users/statistics</code>
        <p>Get user statistics and analytics</p>
      </div>
      
      <h3>🎪 Event Management</h3>
      
      <div class="endpoint">
        <span class="method post">POST</span> <code>/api/v1/events</code>
        <p>Create a new event (supports JSON and multipart form data)</p>
      </div>
      
      <div class="endpoint">
        <span class="method get">GET</span> <code>/api/v1/events</code>
        <p>List all events (paginated)</p>
      </div>
      
      <div class="endpoint">
        <span class="method get">GET</span> <code>/api/v1/events/{eventId}</code>
        <p>Get specific event by ID</p>
      </div>
      
      <div class="endpoint">
        <span class="method put">PUT</span> <code>/api/v1/events/{eventId}</code>
        <p>Update existing event</p>
      </div>
      
      <div class="endpoint">
        <span class="method delete">DELETE</span> <code>/api/v1/events/{eventId}</code>
        <p>Delete event</p>
      </div>
      
      <div class="endpoint">
        <span class="method post">POST</span> <code>/api/v1/simulations/{simulationId}/trigger</code>
        <p>Start AI simulation</p>
      </div>
      
      <div class="endpoint">
        <span class="method get">GET</span> <code>/api/v1/simulations/{simulationId}/status</code>
        <p>Get simulation status</p>
      </div>
      
      <div class="endpoint">
        <span class="method get">GET</span> <code>/api/v1/simulations/{simulationId}/results</code>
        <p>Get simulation results</p>
      </div>
      
      <div class="endpoint">
        <span class="method get">GET</span> <code>/api/v1/simulations</code>
        <p>List all simulations (paginated)</p>
      </div>
      
      <h2>🧪 Quick Test</h2>
      <p>Test the API with curl:</p>
      <pre><code>curl ${serverUrl}/health</code></pre>
      <pre><code># Create a user
curl -X POST ${serverUrl}/api/v1/users \\
  -H "Content-Type: application/json" \\
  -d '{"email":"test@example.com","username":"testuser","firstName":"Test","lastName":"User","password":"SecurePass123!","role":"VIEWER"}'</code></pre>
      <pre><code># Create an event
curl -X POST ${serverUrl}/api/v1/events \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Test Event","venue":"Test Venue","expectedAttendees":100,"eventDate":"2024-12-31T20:00:00Z","eventType":"CONCERT"}'</code></pre>
      
      <h2>📚 Full Documentation</h2>
      <p>For complete interactive documentation, try:</p>
      <ul>
        <li><a href="${serverUrl}/api-docs">Swagger UI</a> (may require HTTPS)</li>
        <li><a href="${serverUrl}/api-docs.json">Download OpenAPI JSON</a></li>
        <li><a href="${serverUrl}/postman-guide">Postman Collection Guide</a></li>
      </ul>
      
      <hr>
      <p><small>Event AI Server - ${new Date().toISOString()}</small></p>
    </body>
    </html>
  `);
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

// Serve OpenAPI JSON with dynamic servers
app.get('/api-docs.json', (req, res) => {
  const dynamicSwaggerDocument = { 
    ...swaggerDocument, 
    servers: configureSwaggerServers(req) 
  };
  
  res.setHeader('Content-Type', 'application/json');
  res.send(dynamicSwaggerDocument);
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
app.use('/api/v1/users', userController);
app.use('/api/v1/events', eventController);
app.use('/api/v1/forecast', forecastController);

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
      users: `${req.protocol}://${req.get('host')}/api/v1/users`,
      events: `${req.protocol}://${req.get('host')}/api/v1/events`,
      forecast: `${req.protocol}://${req.get('host')}/api/v1/forecast`
    }
  });
});

// API Routes
app.use('/api/v1/users', userController);
app.use('/api/v1/events', eventController);
app.use('/api/v1/forecast', forecastController);
app.use('/api/v1/prediction', predictionController);

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
  cronService.stop();
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  cronService.stop();
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
  
  // Initialize cron service for predictions
  cronService.start();
});

module.exports = app;
