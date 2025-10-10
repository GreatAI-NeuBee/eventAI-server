const express = require('express');
const { body, validationResult } = require('express-validator');
const winston = require('winston');
const supabaseService = require('../services/supabaseService');
const pushNotificationService = require('../services/pushNotificationService');
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
  defaultMeta: { service: 'notification-controller' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

/**
 * POST /api/v1/notifications/subscribe
 * Subscribe a user to push notifications for an event
 */
router.post('/subscribe', [
  body('eventId')
    .isString()
    .notEmpty()
    .withMessage('Event ID is required'),
  body('subscription')
    .isObject()
    .withMessage('Subscription object is required'),
  body('subscription.endpoint')
    .isString()
    .notEmpty()
    .withMessage('Subscription endpoint is required'),
  body('subscription.keys')
    .isObject()
    .withMessage('Subscription keys are required'),
  body('subscription.keys.p256dh')
    .isString()
    .notEmpty()
    .withMessage('p256dh key is required'),
  body('subscription.keys.auth')
    .isString()
    .notEmpty()
    .withMessage('auth key is required')
], asyncHandler(async (req, res) => {
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
      timestamp: new Date().toISOString()
    });
  }

  const { eventId, subscription } = req.body;
  const { endpoint, keys } = subscription;

  logger.info('📝 [Notification] Subscription request received', {
    eventId,
    endpoint: endpoint.substring(0, 50) + '...'
  });

  try {
    // Get user agent and IP
    const userAgent = req.headers['user-agent'];
    const ipAddress = req.ip || req.connection.remoteAddress;

    // Insert or update subscription
    const { data, error } = await supabaseService.client
      .from('push_subscriptions')
      .upsert({
        event_id: eventId,
        endpoint: endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: userAgent,
        ip_address: ipAddress,
        is_active: true,
        failed_attempts: 0,
        subscribed_at: new Date().toISOString()
      }, {
        onConflict: 'event_id,endpoint',
        returning: 'minimal'
      })
      .select('id, subscribed_at')
      .single();

    if (error) {
      logger.error('❌ [Notification] Error saving subscription', {
        eventId,
        error: error.message
      });
      throw error;
    }

    logger.info('✅ [Notification] Subscription saved successfully', {
      eventId,
      subscriptionId: data?.id
    });

    res.status(201).json({
      success: true,
      message: 'Successfully subscribed to push notifications',
      data: {
        subscriptionId: data?.id,
        subscribedAt: data?.subscribed_at,
        eventId
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ [Notification] Error processing subscription', {
      eventId,
      error: error.message
    });
    throw new AppError('Failed to save subscription', 500, error.message);
  }
}));

/**
 * POST /api/v1/notifications/unsubscribe
 * Unsubscribe from push notifications
 */
router.post('/unsubscribe', [
  body('endpoint')
    .isString()
    .notEmpty()
    .withMessage('Endpoint is required')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        status: 'fail',
        message: 'Validation failed',
        details: errors.array()
      },
      timestamp: new Date().toISOString()
    });
  }

  const { endpoint } = req.body;

  logger.info('🔕 [Notification] Unsubscribe request received', {
    endpoint: endpoint.substring(0, 50) + '...'
  });

  try {
    const { error } = await supabaseService.client
      .from('push_subscriptions')
      .update({ is_active: false })
      .eq('endpoint', endpoint);

    if (error) {
      logger.error('❌ [Notification] Error unsubscribing', {
        error: error.message
      });
      throw error;
    }

    logger.info('✅ [Notification] Unsubscribed successfully');

    res.json({
      success: true,
      message: 'Successfully unsubscribed from push notifications',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ [Notification] Error processing unsubscribe', {
      error: error.message
    });
    throw new AppError('Failed to unsubscribe', 500, error.message);
  }
}));

/**
 * GET /api/v1/notifications/subscriptions/:eventId
 * Get subscription count for an event
 */
router.get('/subscriptions/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  logger.info('📊 [Notification] Getting subscription count', { eventId });

  try {
    const count = await pushNotificationService.getSubscriptionCount(eventId);

    res.json({
      success: true,
      data: {
        eventId,
        activeSubscriptions: count
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ [Notification] Error getting subscription count', {
      eventId,
      error: error.message
    });
    throw new AppError('Failed to get subscription count', 500, error.message);
  }
}));

/**
 * POST /api/v1/notifications/test
 * Send a test notification to an event's subscribers
 */
router.post('/test', [
  body('eventId')
    .isString()
    .notEmpty()
    .withMessage('Event ID is required'),
  body('message')
    .optional()
    .isString()
    .withMessage('Message must be a string')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        status: 'fail',
        message: 'Validation failed',
        details: errors.array()
      },
      timestamp: new Date().toISOString()
    });
  }

  const { eventId, message } = req.body;

  logger.info('🧪 [Notification] Sending test notification', { eventId });

  try {
    const result = await pushNotificationService.sendToEvent(eventId, {
      title: '🧪 Test Notification',
      body: message || 'This is a test push notification from EventBuddy!',
      tag: 'test',
      requireInteraction: false,
      data: {
        type: 'test',
        eventId,
        timestamp: Date.now()
      }
    });

    logger.info('✅ [Notification] Test notification sent', {
      eventId,
      sent: result.sent,
      failed: result.failed
    });

    res.json({
      success: true,
      message: 'Test notification sent',
      data: {
        eventId,
        sent: result.sent,
        failed: result.failed,
        totalAttempts: result.sent + result.failed
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ [Notification] Error sending test notification', {
      eventId,
      error: error.message
    });
    throw new AppError('Failed to send test notification', 500, error.message);
  }
}));

/**
 * POST /api/v1/notifications/send
 * Send a custom notification to event subscribers
 */
router.post('/send', [
  body('eventId')
    .isString()
    .notEmpty()
    .withMessage('Event ID is required'),
  body('title')
    .isString()
    .notEmpty()
    .withMessage('Title is required'),
  body('body')
    .isString()
    .notEmpty()
    .withMessage('Body is required'),
  body('requireInteraction')
    .optional()
    .isBoolean()
    .withMessage('requireInteraction must be boolean'),
  body('data')
    .optional()
    .isObject()
    .withMessage('data must be an object')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        status: 'fail',
        message: 'Validation failed',
        details: errors.array()
      },
      timestamp: new Date().toISOString()
    });
  }

  const { eventId, title, body, requireInteraction, data } = req.body;

  logger.info('📤 [Notification] Sending custom notification', {
    eventId,
    title
  });

  try {
    const result = await pushNotificationService.sendToEvent(eventId, {
      title,
      body,
      requireInteraction: requireInteraction || false,
      data: data || { type: 'custom' }
    });

    logger.info('✅ [Notification] Custom notification sent', {
      eventId,
      sent: result.sent,
      failed: result.failed
    });

    res.json({
      success: true,
      message: 'Notification sent successfully',
      data: {
        eventId,
        sent: result.sent,
        failed: result.failed,
        totalAttempts: result.sent + result.failed
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ [Notification] Error sending notification', {
      eventId,
      error: error.message
    });
    throw new AppError('Failed to send notification', 500, error.message);
  }
}));

/**
 * GET /api/v1/notifications/public-key
 * Get the VAPID public key for frontend use
 */
router.get('/public-key', (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;

  if (!publicKey) {
    logger.error('❌ [Notification] VAPID public key not configured');
    return res.status(500).json({
      success: false,
      error: {
        status: 'error',
        message: 'Push notifications not configured'
      },
      timestamp: new Date().toISOString()
    });
  }

  res.json({
    success: true,
    data: {
      publicKey
    },
    timestamp: new Date().toISOString()
  });
});

module.exports = router;

