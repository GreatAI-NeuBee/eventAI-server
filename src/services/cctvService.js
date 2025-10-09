const axios = require('axios');
const winston = require('winston');
const sharp = require('sharp');
const s3Service = require('./s3Service');
const eventService = require('./eventService');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'cctv-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

class CCTVService {
  constructor() {
    // CCTV摄像头配置 - 每个event可以有自己的摄像头设置
    // 也可以从数据库或配置文件读取
    this.cctvConfig = this.loadCCTVConfig();
    
    // Image quality configuration
    this.imageQuality = {
      // Use PNG for lossless quality (larger file size) or JPEG (smaller, some quality loss)
      format: process.env.CCTV_IMAGE_FORMAT || 'jpeg', // 'jpeg' or 'png'
      jpegQuality: parseInt(process.env.CCTV_JPEG_QUALITY) || 100, // 1-100
      pngCompressionLevel: parseInt(process.env.CCTV_PNG_COMPRESSION) || 6, // 0-9 (6 is default)
      // Upscale low resolution images
      minWidth: parseInt(process.env.CCTV_MIN_WIDTH) || 800, // Minimum width for AI model
      minHeight: parseInt(process.env.CCTV_MIN_HEIGHT) || 600, // Minimum height for AI model
      upscaleEnabled: process.env.CCTV_UPSCALE_ENABLED !== 'false' // Enable by default
    };
    
    logger.info('CCTV Service image quality configuration', this.imageQuality);
  }

  /**
   * 加载CCTV摄像头配置
   * 可以从环境变量、数据库或配置文件读取
   * @returns {Object} - CCTV配置
   */
  loadCCTVConfig() {
    // 示例配置格式
    // 可以根据实际情况修改为从数据库读取
    return {
      // 默认摄像头URLs（如果event没有特定配置）
      defaultCameras: [
        {
          gateId: '1',
          cameraUrl: process.env.CCTV_GATE_1_URL || null,
          name: 'Gate 1 Camera'
        },
        {
          gateId: 'A',
          cameraUrl: process.env.CCTV_GATE_A_URL || null,
          name: 'Gate A Camera'
        },
        {
          gateId: 'B',
          cameraUrl: process.env.CCTV_GATE_B_URL || null,
          name: 'Gate B Camera'
        },
        {
          gateId: 'C',
          cameraUrl: process.env.CCTV_GATE_C_URL || null,
          name: 'Gate C Camera'
        },
        {
          gateId: 'D',
          cameraUrl: process.env.CCTV_GATE_D_URL || null,
          name: 'Gate D Camera'
        }
      ],
      // Event特定配置可以存储在数据库中
      eventSpecificCameras: {}
    };
  }

  /**
   * 为指定event的所有gates捕获并上传CCTV快照
   * @param {Object} event - Event对象
   * @returns {Promise<Object>} - 上传结果
   */
  async captureAndUploadSnapshots(event) {
    try {
      logger.info('Starting CCTV snapshot capture', { 
        eventId: event.eventId,
        eventName: event.eventName 
      });

      // 获取该event的gates列表
      const gates = this.getEventGates(event);
      
      if (!gates || gates.length === 0) {
        logger.warn('No gates found for event', { eventId: event.eventId });
        return { success: false, message: 'No gates found' };
      }

      // 获取摄像头配置
      const cameras = this.getCameraConfig(event);

      const uploadResults = [];
      const errors = [];

      // 为每个gate捕获和上传快照
      for (const gate of gates) {
        try {
          const camera = cameras.find(cam => cam.gateId === gate);
          
          if (!camera || !camera.cameraUrl) {
            logger.warn('No camera URL configured for gate', { 
              eventId: event.eventId, 
              gateId: gate 
            });
            
            // 如果没有摄像头URL，跳过该gate
            errors.push({
              gateId: gate,
              error: 'No camera URL configured'
            });
            continue;
          }

          // 捕获快照
          const imageBuffer = await this.captureSnapshot(camera.cameraUrl, gate);
          
          // 上传到S3
          const s3Result = await this.uploadSnapshotToS3(
            event.eventId, 
            gate, 
            imageBuffer
          );

          uploadResults.push({
            gateId: gate,
            s3Url: s3Result.publicUrl,
            s3Key: s3Result.key,
            capturedAt: new Date().toISOString(),
            cameraName: camera.name
          });

          logger.info('Snapshot uploaded successfully', { 
            eventId: event.eventId, 
            gateId: gate,
            s3Url: s3Result.publicUrl 
          });

        } catch (error) {
          logger.error('Error processing gate snapshot', { 
            eventId: event.eventId, 
            gateId: gate,
            error: error.message 
          });
          
          errors.push({
            gateId: gate,
            error: error.message
          });
        }
      }

      // 更新event的webcamImages字段
      if (uploadResults.length > 0) {
        await this.updateEventWebcamImages(event.eventId, uploadResults);
      }

      const result = {
        success: true,
        eventId: event.eventId,
        totalGates: gates.length,
        uploaded: uploadResults.length,
        failed: errors.length,
        uploadResults,
        errors,
        processedAt: new Date().toISOString()
      };

      logger.info('CCTV snapshot capture completed', { 
        eventId: event.eventId,
        uploaded: uploadResults.length,
        failed: errors.length
      });

      return result;

    } catch (error) {
      logger.error('Error in CCTV snapshot capture', { 
        eventId: event.eventId,
        error: error.message 
      });
      
      return {
        success: false,
        eventId: event.eventId,
        error: error.message,
        processedAt: new Date().toISOString()
      };
    }
  }

  /**
   * 从摄像头URL捕获快照
   * 支持多种摄像头类型：HTTP snapshot URL、RTSP流等
   * @param {string} cameraUrl - 摄像头URL
   * @param {string} gateId - Gate ID
   * @returns {Promise<Buffer>} - 图像buffer
   */
  async captureSnapshot(cameraUrl, gateId) {
    try {
      logger.info('Capturing snapshot from camera', { cameraUrl, gateId });

      // 方式1: 直接HTTP/HTTPS图像URL
      if (cameraUrl.startsWith('http')) {
        const response = await axios.get(cameraUrl, {
          responseType: 'arraybuffer',
          timeout: 10000, // 10秒超时
          headers: {
            'User-Agent': 'EventAI-CCTV-Service/1.0'
          }
        });

        if (response.status === 200) {
          const originalBuffer = Buffer.from(response.data);
          const contentType = response.headers['content-type'] || '';
          
          logger.info('Snapshot captured successfully', { 
            gateId,
            size: originalBuffer.length,
            contentType 
          });
          
          // Process and optimize image for AI model
          try {
            return await this.processImageForAI(originalBuffer, contentType, gateId);
          } catch (processError) {
            logger.error('Image processing failed, using original', { 
              gateId, 
              error: processError.message 
            });
            return originalBuffer;
          }
        } else {
          throw new Error(`Failed to capture snapshot: HTTP ${response.status}`);
        }
      }

      // 方式2: RTSP流 (需要额外的库如ffmpeg)
      // 这里提供placeholder，实际使用时需要实现RTSP处理
      if (cameraUrl.startsWith('rtsp://')) {
        logger.warn('RTSP stream capture not yet implemented', { gateId });
        throw new Error('RTSP stream capture requires additional implementation');
      }

      // 方式3: 本地文件路径（用于测试）
      if (cameraUrl.startsWith('file://')) {
        const fs = require('fs').promises;
        const filePath = cameraUrl.replace('file://', '');
        const buffer = await fs.readFile(filePath);
        logger.info('Snapshot loaded from file', { gateId, filePath });
        return buffer;
      }

      throw new Error(`Unsupported camera URL format: ${cameraUrl}`);

    } catch (error) {
      logger.error('Error capturing snapshot', { 
        gateId, 
        cameraUrl,
        error: error.message 
      });
      throw new Error(`Failed to capture snapshot for gate ${gateId}: ${error.message}`);
    }
  }

  /**
   * Process image for AI model with optimal quality
   * @param {Buffer} imageBuffer - Original image buffer
   * @param {string} contentType - Image content type
   * @param {string} gateId - Gate ID for logging
   * @returns {Promise<Buffer>} - Processed image buffer
   */
  async processImageForAI(imageBuffer, contentType, gateId) {
    try {
      // Get image metadata
      const metadata = await sharp(imageBuffer).metadata();
      logger.info('Processing image for AI model', { 
        gateId,
        originalFormat: metadata.format,
        originalWidth: metadata.width,
        originalHeight: metadata.height,
        originalSize: imageBuffer.length,
        contentType,
        targetFormat: this.imageQuality.format
      });

      let sharpInstance = sharp(imageBuffer);

      // Upscale if image is too small
      if (this.imageQuality.upscaleEnabled) {
        const needsUpscale = metadata.width < this.imageQuality.minWidth || 
                            metadata.height < this.imageQuality.minHeight;
        
        if (needsUpscale) {
          const targetWidth = Math.max(metadata.width, this.imageQuality.minWidth);
          const targetHeight = Math.max(metadata.height, this.imageQuality.minHeight);
          
          logger.info('Upscaling image for better AI analysis', {
            gateId,
            from: `${metadata.width}x${metadata.height}`,
            to: `${targetWidth}x${targetHeight}`
          });

          sharpInstance = sharpInstance.resize(targetWidth, targetHeight, {
            fit: 'inside',
            kernel: 'lanczos3', // Best quality for upscaling
            withoutEnlargement: false
          });
        }
      }

      // Convert to target format
      let processedBuffer;
      let fileExtension;

      if (this.imageQuality.format === 'png') {
        // PNG - Lossless, larger file size
        processedBuffer = await sharpInstance
          .png({ 
            compressionLevel: this.imageQuality.pngCompressionLevel,
            adaptiveFiltering: true, // Better compression
            palette: false // Full color, no palette
          })
          .toBuffer();
        fileExtension = 'png';
        
        logger.info('Image converted to PNG (lossless)', {
          gateId,
          originalSize: imageBuffer.length,
          pngSize: processedBuffer.length,
          compression: `${((1 - processedBuffer.length / imageBuffer.length) * 100).toFixed(1)}%`
        });
      } else {
        // JPEG - Check if already JPEG and high quality, use original if possible
        if ((contentType.includes('jpeg') || contentType.includes('jpg')) && 
            !this.imageQuality.upscaleEnabled) {
          logger.info('Image is already JPEG and no upscaling needed, using original', { gateId });
          return imageBuffer;
        }

        // Convert to high-quality JPEG
        processedBuffer = await sharpInstance
          .jpeg({ 
            quality: this.imageQuality.jpegQuality,
            chromaSubsampling: '4:4:4', // No color subsampling for max quality
            mozjpeg: true, // Use MozJPEG for better quality
            trellisQuantisation: true, // Better quality
            overshootDeringing: true, // Reduce ringing artifacts
            optimiseScans: true // Optimize progressive scans
          })
          .toBuffer();
        fileExtension = 'jpg';

        logger.info('Image converted to JPEG', {
          gateId,
          quality: this.imageQuality.jpegQuality,
          originalSize: imageBuffer.length,
          jpegSize: processedBuffer.length,
          compression: `${((1 - processedBuffer.length / imageBuffer.length) * 100).toFixed(1)}%`
        });
      }

      return processedBuffer;

    } catch (error) {
      logger.error('Error processing image for AI', {
        gateId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 上传快照到S3 - 使用共享的CCTV snapshots文件夹
   * @param {string} eventId - Event ID (仅用于日志)
   * @param {string} gateId - Gate ID
   * @param {Buffer} imageBuffer - 图像buffer
   * @returns {Promise<Object>} - S3上传结果
   */
  async uploadSnapshotToS3(eventId, gateId, imageBuffer) {
    try {
      // Determine file extension based on image format configuration
      const fileExtension = this.imageQuality.format === 'png' ? 'png' : 'jpg';
      const contentType = this.imageQuality.format === 'png' ? 'image/png' : 'image/jpeg';
      
      // Use shared CCTV snapshots folder, not per-event folder
      // This allows all events to reference the same latest snapshots
      const timestamp = Date.now();
      const key = `cctv-snapshots/gate_${gateId}/latest.${fileExtension}`; // Overwrite latest image
      const archiveKey = `cctv-snapshots/gate_${gateId}/archive/${timestamp}.${fileExtension}`; // Keep archive

      logger.info('Uploading snapshot to S3 (shared folder)', { 
        eventId, 
        gateId, 
        key,
        archiveKey,
        size: imageBuffer.length,
        format: this.imageQuality.format,
        contentType
      });

      // Upload latest snapshot (overwrites previous)
      const s3Url = await s3Service.uploadFile(key, imageBuffer, contentType);
      
      // Also archive with timestamp (optional - can be disabled if storage is a concern)
      if (process.env.CCTV_ARCHIVE_ENABLED !== 'false') {
        try {
          await s3Service.uploadFile(archiveKey, imageBuffer, contentType);
          logger.debug('Archived snapshot', { gateId, archiveKey });
        } catch (archiveError) {
          logger.warn('Failed to archive snapshot, continuing', { 
            gateId, 
            error: archiveError.message 
          });
        }
      }

      return {
        key,
        publicUrl: s3Url,
        uploadedAt: new Date().toISOString()
      };

    } catch (error) {
      logger.error('Error uploading snapshot to S3', { 
        eventId, 
        gateId,
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * 更新event的webcamImages字段 - 使用共享快照URLs
   * @param {string} eventId - Event ID
   * @param {Array} uploadResults - 上传结果数组
   * @returns {Promise<void>}
   */
  async updateEventWebcamImages(eventId, uploadResults) {
    try {
      logger.info('Updating event webcam images (shared)', { 
        eventId,
        imagesCount: uploadResults.length 
      });

      // 构造webcamImages数组 - 使用共享快照URLs
      const webcamImages = uploadResults.map(result => ({
        gateId: result.gateId,
        imageUrl: result.s3Url, // 这是共享文件夹的URL
        s3Key: result.s3Key,
        lastUpdated: result.capturedAt,
        source: 'cctv_shared', // 标记为共享快照
        isShared: true // 标记这是共享文件夹中的图像
      }));

      // 更新event
      await eventService.updateEvent(eventId, {
        webcamImages,
        lastCctvUpdate: new Date().toISOString()
      });

      logger.info('Event webcam images updated successfully (shared)', { 
        eventId,
        sharedUrls: webcamImages.map(img => ({ gateId: img.gateId, url: img.imageUrl }))
      });

    } catch (error) {
      logger.error('Error updating event webcam images', { 
        eventId,
        error: error.message 
      });
      // 不抛出错误，只记录日志，因为图像已经上传成功
    }
  }

  /**
   * 获取event的gates列表
   * @param {Object} event - Event对象
   * @returns {Array} - Gates数组
   */
  getEventGates(event) {
    // 优先从forecast_result获取
    if (event.forecastResult?.summary?.gates) {
      return event.forecastResult.summary.gates;
    }

    // 备选：从predict_result获取
    if (event.predictResult) {
      return Object.keys(event.predictResult);
    }

    // 默认gates
    return ['1', 'A', 'B', 'C', 'D'];
  }

  /**
   * 获取event的摄像头配置
   * @param {Object} event - Event对象
   * @returns {Array} - 摄像头配置数组
   */
  getCameraConfig(event) {
    // 优先使用event特定的摄像头配置
    if (event.cctvConfig && Array.isArray(event.cctvConfig.cameras)) {
      logger.info('Using event-specific CCTV config', { 
        eventId: event.eventId,
        camerasCount: event.cctvConfig.cameras.length 
      });
      return event.cctvConfig.cameras;
    }

    // 使用默认配置
    logger.info('Using default CCTV config', { 
      eventId: event.eventId 
    });
    return this.cctvConfig.defaultCameras;
  }

  /**
   * 获取指定gate的最新快照URL (从共享CCTV文件夹)
   * @param {string} gateId - Gate ID
   * @returns {string} - 快照URL
   */
  getSharedSnapshotUrl(gateId) {
    // Use S3 base URL from environment
    const s3BaseUrl = process.env.AWS_S3_PUBLIC_URL || 
                      `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
    
    // Use configured file extension
    const fileExtension = this.imageQuality.format === 'png' ? 'png' : 'jpg';
    
    // Return shared snapshot URL with correct extension
    return `${s3BaseUrl}/cctv-snapshots/gate_${gateId}/latest.${fileExtension}`;
  }

  /**
   * 获取所有gates的共享快照URLs
   * @param {Array} gateIds - Gate IDs数组
   * @returns {Array} - Webcam images数组
   */
  getSharedSnapshotUrls(gateIds) {
    return gateIds.map(gateId => ({
      gateId,
      imageUrl: this.getSharedSnapshotUrl(gateId),
      source: 'cctv_shared',
      isShared: true, // Flag to indicate this is from shared folder
      lastUpdated: new Date().toISOString()
    }));
  }

  /**
   * 获取指定gate的最新快照URL (兼容旧版本)
   * @param {string} eventId - Event ID (可选，已废弃)
   * @param {string} gateId - Gate ID
   * @returns {Promise<string|null>} - 快照URL或null
   */
  async getLatestSnapshotUrl(eventId, gateId) {
    try {
      // 新版本：使用共享文件夹
      return this.getSharedSnapshotUrl(gateId);

    } catch (error) {
      logger.error('Error getting latest snapshot URL', { 
        eventId, 
        gateId,
        error: error.message 
      });
      return null;
    }
  }

  /**
   * 清理旧的CCTV快照（可选，节省S3存储）
   * 保留最近N个快照，删除旧的
   * @param {string} eventId - Event ID
   * @param {string} gateId - Gate ID
   * @param {number} keepCount - 保留的快照数量
   * @returns {Promise<Object>} - 清理结果
   */
  async cleanupOldSnapshots(eventId, gateId, keepCount = 10) {
    try {
      logger.info('Cleaning up old CCTV snapshots', { 
        eventId, 
        gateId, 
        keepCount 
      });

      // 这需要AWS SDK的ListObjects功能
      // 简化实现：只记录，实际清理可以通过S3 lifecycle policy自动完成
      logger.info('Snapshot cleanup scheduled', { eventId, gateId });

      return {
        success: true,
        message: 'Cleanup can be configured via S3 lifecycle policies'
      };

    } catch (error) {
      logger.error('Error cleaning up snapshots', { 
        eventId, 
        gateId,
        error: error.message 
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 处理所有正在进行的events的CCTV快照
   * 用于cron job调用
   * @returns {Promise<Object>} - 处理结果
   */
  async processAllOngoingEvents() {
    try {
      logger.info('Starting CCTV snapshot processing for all ongoing events');

      // 获取所有正在进行的events
      // 复用cronService的逻辑
      const events = await this.getOngoingEvents();

      if (!events || events.length === 0) {
        logger.info('No ongoing events found for CCTV processing');
        return {
          success: true,
          processedEvents: 0,
          message: 'No ongoing events'
        };
      }

      logger.info('Found ongoing events for CCTV processing', { 
        count: events.length 
      });

      const results = [];
      let successCount = 0;
      let failureCount = 0;

      for (const event of events) {
        try {
          const result = await this.captureAndUploadSnapshots(event);
          results.push(result);
          
          if (result.success) {
            successCount++;
          } else {
            failureCount++;
          }

        } catch (error) {
          logger.error('Error processing event CCTV snapshots', { 
            eventId: event.eventId,
            error: error.message 
          });
          failureCount++;
        }
      }

      const summary = {
        success: true,
        totalEvents: events.length,
        successCount,
        failureCount,
        results,
        processedAt: new Date().toISOString()
      };

      logger.info('CCTV snapshot processing completed', { 
        totalEvents: events.length,
        successCount,
        failureCount 
      });

      return summary;

    } catch (error) {
      logger.error('Error in CCTV snapshot processing', { 
        error: error.message 
      });
      
      return {
        success: false,
        error: error.message,
        processedAt: new Date().toISOString()
      };
    }
  }

  /**
   * 获取正在进行的events
   * 复用cronService的逻辑
   * @returns {Promise<Array>} - Events数组
   */
  async getOngoingEvents() {
    try {
      // 获取所有events
      const { events } = await eventService.getEvents(1000, 0, {});
      
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

      // 筛选今天的events
      const todaysEvents = events.filter(event => {
        if (!event.dateOfEventStart) return false;
        
        const eventStart = new Date(event.dateOfEventStart);
        const eventStartDate = new Date(
          eventStart.getFullYear(), 
          eventStart.getMonth(), 
          eventStart.getDate()
        );
        
        const todayDate = new Date(
          todayStart.getFullYear(), 
          todayStart.getMonth(), 
          todayStart.getDate()
        );
        
        return eventStartDate.getTime() === todayDate.getTime();
      });

      // 筛选正在进行的events
      const ongoingEvents = todaysEvents.filter(event => {
        if (!event.forecastResult?.summary?.forecastPeriod) {
          return false;
        }

        const forecastPeriod = event.forecastResult.summary.forecastPeriod;
        const forecastStart = this.parseAsUTC(forecastPeriod.start);
        const forecastEnd = this.parseAsUTC(forecastPeriod.end);

        const ONE_HOUR_MS = 60 * 60 * 1000;
        const predictionWindowStart = new Date(forecastStart.getTime() - ONE_HOUR_MS);

        const isWithinWindow = now >= predictionWindowStart && now <= forecastEnd;
        return isWithinWindow;
      });

      return ongoingEvents;

    } catch (error) {
      logger.error('Error getting ongoing events', { error: error.message });
      return [];
    }
  }

  /**
   * 解析时间戳为UTC (复用cronService的逻辑)
   * @param {string} timestamp - 时间戳
   * @returns {Date} - UTC Date对象
   */
  parseAsUTC(timestamp) {
    if (!timestamp) return new Date();
    
    if (timestamp.includes('Z') || timestamp.includes('+') || timestamp.includes('-')) {
      return new Date(timestamp);
    }
    
    const match = timestamp.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (match) {
      const [, year, month, day, hour, minute, second] = match;
      const MALAYSIA_OFFSET_HOURS = 8;
      return new Date(Date.UTC(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour) - MALAYSIA_OFFSET_HOURS,
        parseInt(minute),
        parseInt(second)
      ));
    }
    
    const isoFormat = timestamp.replace(' ', 'T') + 'Z';
    return new Date(isoFormat);
  }
}

module.exports = new CCTVService();

