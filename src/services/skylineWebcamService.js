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
  defaultMeta: { service: 'skyline-webcam-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

/**
 * SkylineWebcams服务
 * 从SkylineWebcams获取实时快照
 */
class SkylineWebcamService {
  constructor() {
    // SkylineWebcams快照URLs
    // 可以从 https://www.skylinewebcams.com 找到更多摄像头
    this.webcams = {
      // 罗马 - 西班牙广场
      piazza_spagna: {
        name: 'Piazza di Spagna - Rome',
        url: 'https://cdn.skylinewebcams.com/_205.webp',
        location: 'Rome, Italy'
      },
      // 罗马 - Trevi喷泉
      trevi_fountain: {
        name: 'Trevi Fountain - Rome',
        url: 'https://cdn.skylinewebcams.com/live286.webp',
        location: 'Rome, Italy'
      },
      // 罗马 - 圆形竞技场
      colosseum: {
        name: 'Rome - Colosseum',
        url: 'https://cdn.skylinewebcams.com/live1151.webp',
        location: 'Rome, Italy'
      },
      // 罗马 - Pantheon
      pantheon: {
        name: 'Rome - Pantheon',
        url: 'https://cdn.skylinewebcams.com/live165.webp',
        location: 'Rome, Italy'
      },
      // 罗马 - Piazza Navona
      piazza_navona: {
        name: 'Piazza Navona - Rome',
        url: 'https://cdn.skylinewebcams.com/live57.webp',
        location: 'Rome, Italy'
      }
    };
  }

  /**
   * 从SkylineWebcam获取快照
   * @param {string} webcamId - Webcam ID (e.g., 'piazza_spagna')
   * @returns {Promise<Buffer>} - 图像buffer
   */
  async getSnapshot(webcamId) {
    try {
      const webcam = this.webcams[webcamId];
      
      if (!webcam) {
        throw new Error(`Unknown webcam ID: ${webcamId}`);
      }

      logger.info('Fetching snapshot from SkylineWebcam', { 
        webcamId, 
        name: webcam.name,
        url: webcam.url 
      });

      const response = await axios.get(webcam.url, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: {
          'User-Agent': 'EventAI-CCTV-Service/1.0',
          'Accept': 'image/webp,image/*,*/*'
        }
      });

      if (response.status === 200) {
        const buffer = Buffer.from(response.data);
        
        logger.info('Snapshot fetched successfully', { 
          webcamId,
          size: buffer.length 
        });
        
        return buffer;
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

    } catch (error) {
      logger.error('Error fetching snapshot', { 
        webcamId,
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * 获取所有可用的摄像头列表
   * @returns {Array} - Webcam列表
   */
  listWebcams() {
    return Object.keys(this.webcams).map(id => ({
      id,
      ...this.webcams[id]
    }));
  }

  /**
   * 测试摄像头URL是否可访问
   * @param {string} webcamId - Webcam ID
   * @returns {Promise<Object>} - 测试结果
   */
  async testWebcam(webcamId) {
    try {
      const webcam = this.webcams[webcamId];
      
      if (!webcam) {
        return {
          success: false,
          webcamId,
          error: 'Unknown webcam ID'
        };
      }

      const response = await axios.head(webcam.url, {
        timeout: 5000
      });

      return {
        success: true,
        webcamId,
        name: webcam.name,
        status: response.status,
        contentType: response.headers['content-type'],
        contentLength: response.headers['content-length']
      };

    } catch (error) {
      return {
        success: false,
        webcamId,
        error: error.message
      };
    }
  }
}

module.exports = new SkylineWebcamService();

