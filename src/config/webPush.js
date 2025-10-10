const webpush = require('web-push');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'webpush-config' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// VAPID Keys Configuration
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@eventbuddy.com';

// Validate VAPID keys are configured
if (!vapidPublicKey || !vapidPrivateKey) {
  logger.error('❌ [WebPush] VAPID keys not configured!', {
    hasPublicKey: !!vapidPublicKey,
    hasPrivateKey: !!vapidPrivateKey
  });
  throw new Error('VAPID keys must be configured in environment variables. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in .env file.');
}

// Set VAPID details for web-push
webpush.setVapidDetails(
  vapidSubject,
  vapidPublicKey,
  vapidPrivateKey
);

logger.info('✅ [WebPush] VAPID configuration initialized', {
  subject: vapidSubject,
  publicKeyLength: vapidPublicKey.length,
  hasPrivateKey: !!vapidPrivateKey
});

// Export configured web-push instance
module.exports = webpush;

