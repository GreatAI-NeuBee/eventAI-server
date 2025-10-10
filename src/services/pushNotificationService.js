const webpush = require('../config/webPush');
const supabaseService = require('./supabaseService');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'push-notification-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

class PushNotificationService {
  /**
   * Send notification to all subscribers of an event
   * @param {string} eventId - Event ID
   * @param {Object} payload - Notification payload
   * @param {string} payload.title - Notification title
   * @param {string} payload.body - Notification body
   * @param {string} [payload.icon] - Icon URL
   * @param {string} [payload.badge] - Badge URL
   * @param {Object} [payload.data] - Additional data
   * @param {string} [payload.tag] - Notification tag (for grouping)
   * @param {boolean} [payload.requireInteraction] - Require user interaction
   * @returns {Promise<{sent: number, failed: number}>}
   */
  async sendToEvent(eventId, payload) {
    try {
      logger.info('📤 [PushNotification] Sending notifications to event subscribers', {
        eventId,
        title: payload.title
      });

      // Get all active subscriptions for this event
      const { data: subscriptions, error } = await supabaseService.client
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth')
        .eq('event_id', eventId)
        .eq('is_active', true);

      if (error) {
        logger.error('❌ [PushNotification] Error fetching subscriptions', {
          eventId,
          error: error.message
        });
        throw error;
      }

      if (!subscriptions || subscriptions.length === 0) {
        logger.info('ℹ️ [PushNotification] No active subscriptions found', {
          eventId
        });
        return { sent: 0, failed: 0 };
      }

      logger.info(`📋 [PushNotification] Found ${subscriptions.length} active subscriptions`, {
        eventId,
        count: subscriptions.length
      });

      let sent = 0;
      let failed = 0;

      // Send to all subscriptions in parallel
      const promises = subscriptions.map(async (sub) => {
        try {
          const pushSubscription = {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth
            }
          };

          const notificationPayload = {
            title: payload.title,
            body: payload.body,
            icon: payload.icon || '/pwa-192x192.png',
            badge: payload.badge || '/pwa-64x64.png',
            data: payload.data || {},
            tag: payload.tag || 'default',
            requireInteraction: payload.requireInteraction || false,
            timestamp: Date.now()
          };

          // Send push notification
          await webpush.sendNotification(
            pushSubscription,
            JSON.stringify(notificationPayload)
          );

          // Update success metrics
          await supabaseService.client
            .from('push_subscriptions')
            .update({
              last_notification_sent: new Date().toISOString(),
              notification_count: supabaseService.client.sql`notification_count + 1`,
              failed_attempts: 0
            })
            .eq('id', sub.id);

          // Log successful notification
          await this.logNotification(sub.id, eventId, payload, 'sent');

          sent++;
          logger.info(`✅ [PushNotification] Sent to subscription ${sub.id}`, {
            eventId,
            endpoint: sub.endpoint.substring(0, 50) + '...'
          });

        } catch (error) {
          failed++;
          logger.error(`❌ [PushNotification] Failed to send to subscription ${sub.id}`, {
            eventId,
            error: error.message,
            statusCode: error.statusCode
          });

          // Handle subscription errors
          if (error.statusCode === 410 || error.statusCode === 404) {
            // Subscription expired/invalid - deactivate it
            logger.warn(`⚠️ [PushNotification] Subscription expired, deactivating`, {
              subscriptionId: sub.id,
              statusCode: error.statusCode
            });

            await supabaseService.client
              .from('push_subscriptions')
              .update({
                is_active: false,
                last_error: 'Subscription expired or not found'
              })
              .eq('id', sub.id);
          } else {
            // Track failure
            await supabaseService.client
              .from('push_subscriptions')
              .update({
                failed_attempts: supabaseService.client.sql`failed_attempts + 1`,
                last_error: error.message
              })
              .eq('id', sub.id);
          }

          // Log failed notification
          await this.logNotification(sub.id, eventId, payload, 'failed', error.message);
        }
      });

      await Promise.all(promises);

      logger.info(`📊 [PushNotification] Notification results`, {
        eventId,
        sent,
        failed,
        total: subscriptions.length,
        successRate: `${((sent / subscriptions.length) * 100).toFixed(1)}%`
      });

      return { sent, failed };

    } catch (error) {
      logger.error('❌ [PushNotification] Error sending notifications', {
        eventId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Send congestion alert notification
   * @param {string} eventId - Event ID
   * @param {string} area - Gate or area name
   * @param {string} level - Congestion level: 'Low', 'Moderate', 'High', 'Overcrowded'
   * @param {number} peopleCount - Number of people
   * @returns {Promise<{sent: number, failed: number}>}
   */
  async sendCongestionAlert(eventId, area, level, peopleCount) {
    const emojis = {
      Low: '🟢',
      Moderate: '🟡',
      High: '🟠',
      Overcrowded: '🔴'
    };

    const messages = {
      Low: 'Congestion is low',
      Moderate: 'Moderate congestion detected',
      High: 'High congestion alert!',
      Overcrowded: '⚠️ OVERCROWDED - Take action!'
    };

    return await this.sendToEvent(eventId, {
      title: `${emojis[level]} ${area}`,
      body: `${messages[level]} - ${peopleCount} people`,
      tag: `congestion-${area}`,
      requireInteraction: level === 'Overcrowded',
      data: {
        type: 'congestion_alert',
        area,
        level,
        peopleCount,
        eventId,
        timestamp: Date.now()
      }
    });
  }

  /**
   * Send event starting soon notification
   * @param {string} eventId - Event ID
   * @param {string} eventName - Event name
   * @param {number} minutesUntilStart - Minutes until event starts
   * @returns {Promise<{sent: number, failed: number}>}
   */
  async sendEventStartingSoon(eventId, eventName, minutesUntilStart) {
    return await this.sendToEvent(eventId, {
      title: `🎉 ${eventName}`,
      body: `Starting in ${minutesUntilStart} minutes! Gates are now open.`,
      tag: 'event-starting',
      requireInteraction: false,
      data: {
        type: 'event_starting',
        eventId,
        eventName,
        minutesUntilStart,
        timestamp: Date.now()
      }
    });
  }

  /**
   * Send emergency alert notification
   * @param {string} eventId - Event ID
   * @param {string} message - Emergency message
   * @param {string} [area] - Affected area (optional)
   * @returns {Promise<{sent: number, failed: number}>}
   */
  async sendEmergencyAlert(eventId, message, area = null) {
    return await this.sendToEvent(eventId, {
      title: '🚨 EMERGENCY ALERT',
      body: area ? `${area}: ${message}` : message,
      tag: 'emergency',
      requireInteraction: true,
      data: {
        type: 'emergency',
        eventId,
        message,
        area,
        timestamp: Date.now()
      }
    });
  }

  /**
   * Log notification to database
   * @param {string} subscriptionId - Subscription ID
   * @param {string} eventId - Event ID
   * @param {Object} payload - Notification payload
   * @param {string} status - 'sent' or 'failed'
   * @param {string} [errorMessage] - Error message if failed
   * @private
   */
  async logNotification(subscriptionId, eventId, payload, status, errorMessage = null) {
    try {
      await supabaseService.client
        .from('notification_logs')
        .insert({
          subscription_id: subscriptionId,
          event_id: eventId,
          title: payload.title,
          body: payload.body,
          data: payload.data || {},
          status,
          error_message: errorMessage
        });
    } catch (error) {
      logger.error('❌ [PushNotification] Error logging notification', {
        subscriptionId,
        eventId,
        error: error.message
      });
      // Don't throw - logging errors shouldn't break notification sending
    }
  }

  /**
   * Get active subscriptions count for an event
   * @param {string} eventId - Event ID
   * @returns {Promise<number>}
   */
  async getSubscriptionCount(eventId) {
    try {
      const { count, error } = await supabaseService.client
        .from('push_subscriptions')
        .select('*', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .eq('is_active', true);

      if (error) throw error;

      return count || 0;
    } catch (error) {
      logger.error('❌ [PushNotification] Error getting subscription count', {
        eventId,
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Cleanup inactive subscriptions (run periodically)
   * Removes subscriptions that have been inactive for 90+ days with 10+ failures
   * @returns {Promise<number>} Number of subscriptions cleaned up
   */
  async cleanupInactiveSubscriptions() {
    try {
      logger.info('🧹 [PushNotification] Starting cleanup of inactive subscriptions');

      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const { data, error } = await supabaseService.client
        .from('push_subscriptions')
        .delete()
        .eq('is_active', false)
        .lt('updated_at', ninetyDaysAgo.toISOString())
        .gt('failed_attempts', 10)
        .select('id');

      if (error) throw error;

      const count = data?.length || 0;

      logger.info(`✅ [PushNotification] Cleanup completed`, {
        cleanedCount: count
      });

      return count;
    } catch (error) {
      logger.error('❌ [PushNotification] Error during cleanup', {
        error: error.message
      });
      return 0;
    }
  }
}

// Export singleton instance
module.exports = new PushNotificationService();

