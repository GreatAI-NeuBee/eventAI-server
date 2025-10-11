const express = require('express');
const { body, validationResult } = require('express-validator');
const winston = require('winston');
const videoStreamingService = require('../services/videoStreamingService');
const { asyncHandler, AppError } = require('../utils/errorHandler');

const router = express.Router();

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'video-streaming-controller' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

/**
 * GET /api/v1/video-streaming/stats
 * Get current video streaming statistics
 */
router.get('/stats', asyncHandler(async (req, res) => {
  try {
    logger.info('📊 Video streaming stats requested');

    const stats = videoStreamingService.getStats();

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Error getting video streaming stats', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}));

/**
 * POST /api/v1/video-streaming/test-fall
 * Manually trigger fall detection for testing (requires sessionId)
 */
router.post(
  '/test-fall',
  [
    body('sessionId').isString().notEmpty().withMessage('Session ID is required'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('❌ Validation error in test fall detection', { errors: errors.array() });
      throw new AppError('Validation Failed', 400, errors.array());
    }

    const { sessionId } = req.body;

    try {
      logger.info('🧪 Testing fall detection', { sessionId });

      const result = await videoStreamingService.testFallDetection(sessionId);

      logger.info('✅ Fall detection test completed', { sessionId, result });

      res.json({
        success: true,
        message: 'Fall detection test triggered successfully',
        data: result,
        sessionId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('❌ Error testing fall detection', {
        sessionId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  })
);

/**
 * GET /api/v1/video-streaming/health
 * Check video streaming service health
 */
router.get('/health', asyncHandler(async (req, res) => {
  try {
    const stats = videoStreamingService.getStats();
    const isHealthy = true; // Add more sophisticated health checks if needed

    res.json({
      success: true,
      status: isHealthy ? 'healthy' : 'unhealthy',
      data: {
        activeStreams: stats.activeStreams,
        fallDetectionEnabled: stats.fallDetectionEnabled,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Error checking video streaming health', {
      error: error.message
    });
    throw error;
  }
}));

/**
 * GET /api/v1/video-streaming/config
 * Get video streaming configuration
 */
router.get('/config', asyncHandler(async (req, res) => {
  try {
    logger.info('⚙️ Video streaming config requested');

    const config = {
      fallDetectionEnabled: process.env.FALL_DETECTION_ENABLED === 'true',
      pythonModelUrl: process.env.FALL_DETECTION_MODEL_URL || 'http://localhost:5000',
      ec2ModelIp: process.env.FALL_DETECTION_EC2_IP,
      apiEndpoint: process.env.FALL_DETECTION_EC2_IP 
        ? `http://${process.env.FALL_DETECTION_EC2_IP}/detect`
        : `${process.env.FALL_DETECTION_MODEL_URL || 'http://localhost:5000'}/detect`,
      maxFrameSize: process.env.MAX_VIDEO_FRAME_SIZE || '1MB',
      supportedFormats: ['image/jpeg', 'image/png', 'image/webp'],
      apiRequestFormat: {
        method: 'POST',
        contentType: 'application/json',
        bodyFormat: {
          frame: 'data:image/jpeg;base64,<base64_string>',
          resize: true,
          width: 980,
          height: 740
        }
      },
      apiResponseFormat: {
        success: 'boolean',
        fall_detected: 'boolean - MAIN INDICATOR',
        detections: 'array of person detections',
        timestamp: 'ISO 8601 timestamp'
      },
      recommendedSettings: {
        frameRate: '5-10 FPS (as per documentation)',
        resolution: '640x480 to 1920x1080',
        format: 'JPEG',
        quality: '70-80%',
        resizeOnServer: true
      },
      websocketConfig: {
        transports: ['websocket', 'polling'],
        pingTimeout: 60000,
        pingInterval: 25000
      }
    };

    res.json({
      success: true,
      data: config,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Error getting video streaming config', {
      error: error.message
    });
    throw error;
  }
}));

/**
 * POST /api/v1/video-streaming/cleanup
 * Manual cleanup of temporary files and inactive sessions
 */
router.post('/cleanup', asyncHandler(async (req, res) => {
  try {
    logger.info('🧹 Manual cleanup requested');

    // Get current stats before cleanup
    const statsBefore = videoStreamingService.getStats();

    // Note: In a production environment, you might want to add authentication
    // or admin-only access for this endpoint

    res.json({
      success: true,
      message: 'Cleanup operation would be performed here',
      data: {
        activeStreamsBefore: statsBefore.activeStreams,
        note: 'Actual cleanup implementation depends on specific requirements'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Error during cleanup', {
      error: error.message
    });
    throw error;
  }
}));

/**
 * GET /api/v1/video-streaming/sessions
 * Get information about active video streaming sessions
 */
router.get('/sessions', asyncHandler(async (req, res) => {
  try {
    logger.info('📋 Active sessions requested');

    const stats = videoStreamingService.getStats();

    res.json({
      success: true,
      data: {
        activeSessionCount: stats.activeStreams,
        sessions: stats.streams || [],
        fallDetectionEnabled: stats.fallDetectionEnabled
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Error getting active sessions', {
      error: error.message
    });
    throw error;
  }
}));

/**
 * GET /api/v1/video-streaming/api-health
 * Check fall detection API health
 */
router.get('/api-health', asyncHandler(async (req, res) => {
  try {
    logger.info('🏥 Fall detection API health check requested');

    const healthResult = await videoStreamingService.checkFallDetectionHealth();

    res.json({
      success: true,
      data: healthResult,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Error checking fall detection API health', {
      error: error.message
    });
    throw error;
  }
}));

module.exports = router;
