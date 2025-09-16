const axios = require('axios');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'notification-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

class NotificationService {
  constructor() {
    this.n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;
    this.whatsappApiUrl = process.env.WHATSAPP_API_URL;
    this.whatsappApiKey = process.env.WHATSAPP_API_KEY;
    this.defaultRecipients = process.env.NOTIFICATION_RECIPIENTS ? 
      process.env.NOTIFICATION_RECIPIENTS.split(',') : [];
  }

  /**
   * Sends WhatsApp alert via n8n webhook
   * @param {string} simulationId - Simulation ID
   * @param {Array} recommendations - Array of recommendations
   * @param {Array} recipients - Phone numbers to send to
   * @returns {Promise<boolean>} - Success status
   */
  async sendWhatsAppAlert(simulationId, recommendations, recipients = null) {
    try {
      logger.info('Sending WhatsApp alert', { simulationId, recommendationsCount: recommendations.length });

      const targetRecipients = recipients || this.defaultRecipients;
      
      if (!targetRecipients || targetRecipients.length === 0) {
        logger.warn('No recipients configured for WhatsApp notifications');
        return false;
      }

      const message = this.formatRecommendationMessage(simulationId, recommendations);
      
      // Try n8n webhook first
      if (this.n8nWebhookUrl) {
        return await this.sendViaWebhook(simulationId, message, targetRecipients);
      }
      
      // Fallback to direct WhatsApp API
      if (this.whatsappApiUrl && this.whatsappApiKey) {
        return await this.sendViaWhatsAppApi(simulationId, message, targetRecipients);
      }

      // Development fallback - log message
      logger.info('WhatsApp notification (development mode)', {
        simulationId,
        message,
        recipients: targetRecipients
      });
      
      return true;
    } catch (error) {
      logger.error('Error sending WhatsApp alert', { simulationId, error: error.message });
      return false;
    }
  }

  /**
   * Sends notification via n8n webhook
   * @param {string} simulationId - Simulation ID
   * @param {string} message - Message to send
   * @param {Array} recipients - Phone numbers
   * @returns {Promise<boolean>} - Success status
   */
  async sendViaWebhook(simulationId, message, recipients) {
    try {
      logger.info('Sending notification via n8n webhook', { simulationId });

      const webhookPayload = {
        simulationId,
        message,
        recipients,
        timestamp: new Date().toISOString(),
        type: 'whatsapp_alert',
        priority: 'high'
      };

      const response = await axios.post(this.n8nWebhookUrl, webhookPayload, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'EventAI-Server/1.0'
        },
        timeout: 30000 // 30 seconds timeout
      });

      if (response.status >= 200 && response.status < 300) {
        logger.info('WhatsApp alert sent successfully via webhook', { 
          simulationId, 
          status: response.status 
        });
        return true;
      } else {
        logger.error('Webhook returned non-success status', { 
          simulationId, 
          status: response.status,
          data: response.data
        });
        return false;
      }
    } catch (error) {
      logger.error('Error sending notification via webhook', { 
        simulationId, 
        error: error.message,
        webhookUrl: this.n8nWebhookUrl
      });
      return false;
    }
  }

  /**
   * Sends notification via direct WhatsApp API
   * @param {string} simulationId - Simulation ID
   * @param {string} message - Message to send
   * @param {Array} recipients - Phone numbers
   * @returns {Promise<boolean>} - Success status
   */
  async sendViaWhatsAppApi(simulationId, message, recipients) {
    try {
      logger.info('Sending notification via WhatsApp API', { simulationId });

      const sendPromises = recipients.map(async (phoneNumber) => {
        const payload = {
          phone: phoneNumber,
          message,
          type: 'text'
        };

        const response = await axios.post(this.whatsappApiUrl, payload, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.whatsappApiKey}`,
            'User-Agent': 'EventAI-Server/1.0'
          },
          timeout: 15000 // 15 seconds timeout per message
        });

        return {
          phoneNumber,
          success: response.status >= 200 && response.status < 300,
          status: response.status,
          response: response.data
        };
      });

      const results = await Promise.allSettled(sendPromises);
      
      const successCount = results.filter(result => 
        result.status === 'fulfilled' && result.value.success
      ).length;

      logger.info('WhatsApp API notifications completed', {
        simulationId,
        total: recipients.length,
        successful: successCount,
        failed: recipients.length - successCount
      });

      return successCount > 0;
    } catch (error) {
      logger.error('Error sending notification via WhatsApp API', { 
        simulationId, 
        error: error.message 
      });
      return false;
    }
  }

  /**
   * Formats recommendations into a WhatsApp message
   * @param {string} simulationId - Simulation ID
   * @param {Array} recommendations - Array of recommendations
   * @returns {string} - Formatted message
   */
  formatRecommendationMessage(simulationId, recommendations) {
    const highPriorityRecs = recommendations.filter(rec => rec.priority === 'HIGH');
    const mediumPriorityRecs = recommendations.filter(rec => rec.priority === 'MEDIUM');

    let message = `🚨 *Event AI Alert* 🚨\n\n`;
    message += `Simulation ID: ${simulationId}\n`;
    message += `Time: ${new Date().toLocaleString()}\n\n`;

    if (highPriorityRecs.length > 0) {
      message += `🔴 *HIGH PRIORITY ACTIONS REQUIRED*\n`;
      highPriorityRecs.forEach((rec, index) => {
        message += `${index + 1}. *${rec.title}*\n`;
        message += `   ${rec.description}\n`;
        message += `   ⏱️ Implementation: ${rec.implementationTime}\n`;
        message += `   📈 Impact: ${rec.estimatedImpact}\n\n`;
      });
    }

    if (mediumPriorityRecs.length > 0) {
      message += `🟡 *MEDIUM PRIORITY RECOMMENDATIONS*\n`;
      mediumPriorityRecs.forEach((rec, index) => {
        message += `${index + 1}. *${rec.title}*\n`;
        message += `   ${rec.description}\n`;
        message += `   ⏱️ Implementation: ${rec.implementationTime}\n\n`;
      });
    }

    message += `\n📊 View detailed results in the Event AI dashboard.`;
    message += `\n\n_This is an automated alert from Event AI System_`;

    return message;
  }

  /**
   * Sends email notification (backup method)
   * @param {string} simulationId - Simulation ID
   * @param {Array} recommendations - Array of recommendations
   * @param {Array} recipients - Email addresses
   * @returns {Promise<boolean>} - Success status
   */
  async sendEmailAlert(simulationId, recommendations, recipients = null) {
    try {
      logger.info('Sending email alert', { simulationId, recommendationsCount: recommendations.length });

      // This is a placeholder for email functionality
      // You can integrate with AWS SES, SendGrid, or other email services
      
      const emailContent = this.formatEmailContent(simulationId, recommendations);
      
      logger.info('Email alert (development mode)', {
        simulationId,
        content: emailContent,
        recipients: recipients || ['admin@eventai.com']
      });

      // TODO: Implement actual email sending logic
      return true;
    } catch (error) {
      logger.error('Error sending email alert', { simulationId, error: error.message });
      return false;
    }
  }

  /**
   * Formats recommendations into email content
   * @param {string} simulationId - Simulation ID
   * @param {Array} recommendations - Array of recommendations
   * @returns {Object} - Email content object
   */
  formatEmailContent(simulationId, recommendations) {
    const subject = `Event AI Alert - Simulation ${simulationId}`;
    
    let htmlContent = `
      <html>
        <body>
          <h2>Event AI Simulation Alert</h2>
          <p><strong>Simulation ID:</strong> ${simulationId}</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          
          <h3>Recommendations:</h3>
    `;

    recommendations.forEach((rec, index) => {
      const priorityColor = rec.priority === 'HIGH' ? '#ff4444' : '#ffaa44';
      htmlContent += `
        <div style="border-left: 4px solid ${priorityColor}; padding-left: 15px; margin: 10px 0;">
          <h4>${index + 1}. ${rec.title}</h4>
          <p><strong>Priority:</strong> <span style="color: ${priorityColor};">${rec.priority}</span></p>
          <p><strong>Description:</strong> ${rec.description}</p>
          <p><strong>Implementation Time:</strong> ${rec.implementationTime}</p>
          <p><strong>Estimated Impact:</strong> ${rec.estimatedImpact}</p>
        </div>
      `;
    });

    htmlContent += `
          <p><em>This is an automated alert from the Event AI System.</em></p>
        </body>
      </html>
    `;

    return {
      subject,
      html: htmlContent,
      text: this.formatRecommendationMessage(simulationId, recommendations)
    };
  }

  /**
   * Sends SMS notification (alternative method)
   * @param {string} simulationId - Simulation ID
   * @param {Array} recommendations - Array of recommendations
   * @param {Array} recipients - Phone numbers
   * @returns {Promise<boolean>} - Success status
   */
  async sendSmsAlert(simulationId, recommendations, recipients = null) {
    try {
      logger.info('Sending SMS alert', { simulationId, recommendationsCount: recommendations.length });

      // This is a placeholder for SMS functionality
      // You can integrate with AWS SNS, Twilio, or other SMS services
      
      const smsMessage = this.formatSmsMessage(simulationId, recommendations);
      
      logger.info('SMS alert (development mode)', {
        simulationId,
        message: smsMessage,
        recipients: recipients || this.defaultRecipients
      });

      // TODO: Implement actual SMS sending logic
      return true;
    } catch (error) {
      logger.error('Error sending SMS alert', { simulationId, error: error.message });
      return false;
    }
  }

  /**
   * Formats recommendations into SMS message
   * @param {string} simulationId - Simulation ID
   * @param {Array} recommendations - Array of recommendations
   * @returns {string} - SMS message
   */
  formatSmsMessage(simulationId, recommendations) {
    const highPriorityCount = recommendations.filter(rec => rec.priority === 'HIGH').length;
    
    let message = `Event AI Alert - Simulation ${simulationId}\n`;
    message += `${highPriorityCount} high priority actions required.\n`;
    
    if (highPriorityCount > 0) {
      const firstHighPriority = recommendations.find(rec => rec.priority === 'HIGH');
      message += `Top action: ${firstHighPriority.title}\n`;
    }
    
    message += `Check dashboard for details.`;
    
    return message;
  }

  /**
   * Tests notification configuration
   * @returns {Promise<Object>} - Test results
   */
  async testNotificationSetup() {
    const testResults = {
      webhook: false,
      whatsappApi: false,
      configuration: {
        webhookUrl: !!this.n8nWebhookUrl,
        whatsappApiUrl: !!this.whatsappApiUrl,
        whatsappApiKey: !!this.whatsappApiKey,
        defaultRecipients: this.defaultRecipients.length
      }
    };

    try {
      // Test webhook if configured
      if (this.n8nWebhookUrl) {
        try {
          const testPayload = {
            test: true,
            message: 'Event AI notification test',
            timestamp: new Date().toISOString()
          };

          const response = await axios.post(this.n8nWebhookUrl, testPayload, {
            timeout: 10000
          });

          testResults.webhook = response.status >= 200 && response.status < 300;
        } catch (error) {
          logger.warn('Webhook test failed', { error: error.message });
        }
      }

      // Test WhatsApp API if configured
      if (this.whatsappApiUrl && this.whatsappApiKey) {
        try {
          // This would depend on your WhatsApp API provider's test endpoint
          testResults.whatsappApi = true; // Placeholder
        } catch (error) {
          logger.warn('WhatsApp API test failed', { error: error.message });
        }
      }

      logger.info('Notification setup test completed', testResults);
      return testResults;
    } catch (error) {
      logger.error('Error testing notification setup', { error: error.message });
      return testResults;
    }
  }
}

module.exports = new NotificationService();

