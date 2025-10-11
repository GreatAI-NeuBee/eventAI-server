const { Server } = require('socket.io');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'video-streaming-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

class VideoStreamingService {
  constructor() {
    this.io = null;
    this.activeStreams = new Map(); // sessionId -> stream info
    this.frameBuffer = new Map(); // sessionId -> frame buffer
    this.fallDetectionEnabled = process.env.FALL_DETECTION_ENABLED === 'true';
    this.pythonModelUrl = process.env.FALL_DETECTION_MODEL_URL || 'http://localhost:5000';
    this.ec2ModelIp = process.env.FALL_DETECTION_EC2_IP;
    this.tempDir = path.join(__dirname, '../../temp/video_frames');
    
    // Ensure temp directory exists
    this.initializeTempDirectory();
    
    logger.info('VideoStreamingService initialized', {
      fallDetectionEnabled: this.fallDetectionEnabled,
      pythonModelUrl: this.pythonModelUrl,
      ec2ModelIp: this.ec2ModelIp,
      tempDir: this.tempDir
    });
  }

  /**
   * Initialize Socket.IO server
   */
  initialize(httpServer) {
    // Configure CORS origins for local and production environments
    const allowedOrigins = [
      'http://localhost:5173',                    // Local Vite dev server
      'https://eventbuddy.munymunyhom.tech',      // Production domain
      'http://localhost:3001',                    // Alternative local port
      'http://127.0.0.1:5173'                     // Alternative localhost format
    ];

    // Add custom FRONTEND_URL if provided
    if (process.env.FRONTEND_URL && !allowedOrigins.includes(process.env.FRONTEND_URL)) {
      allowedOrigins.push(process.env.FRONTEND_URL);
    }

    this.io = new Server(httpServer, {
      cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.setupSocketHandlers();
    
    logger.info('✅ Socket.IO server initialized for video streaming', {
      allowedOrigins: allowedOrigins,
      customFrontendUrl: process.env.FRONTEND_URL
    });

    return this.io;
  }

  /**
   * Set up Socket.IO event handlers
   */
  setupSocketHandlers() {
    this.io.on('connection', (socket) => {
      logger.info('🔌 Client connected for video streaming', {
        socketId: socket.id,
        clientIP: socket.handshake.address
      });

      // Handle video stream start
      socket.on('start_video_stream', async (data) => {
        await this.handleStreamStart(socket, data);
      });

      // Handle video frame data
      socket.on('video_frame', async (data) => {
        await this.handleVideoFrame(socket, data);
      });

      // Handle stream stop
      socket.on('stop_video_stream', async (data) => {
        await this.handleStreamStop(socket, data);
      });

      // Handle disconnection
      socket.on('disconnect', (reason) => {
        this.handleDisconnection(socket, reason);
      });

      // Handle ping for connection health
      socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
      });
    });
  }

  /**
   * Handle video stream start
   */
  async handleStreamStart(socket, data) {
    try {
      const sessionId = data.sessionId || uuidv4();
      const eventId = data.eventId;
      
      logger.info('🎥 Starting video stream', {
        socketId: socket.id,
        sessionId,
        eventId,
        streamConfig: data.config
      });

      // Store stream information
      this.activeStreams.set(sessionId, {
        socketId: socket.id,
        eventId,
        startTime: Date.now(),
        frameCount: 0,
        lastFrameTime: null,
        config: data.config || {},
        fallDetected: false
      });

      // Initialize frame buffer
      this.frameBuffer.set(sessionId, []);

      // Join session room
      socket.join(`stream_${sessionId}`);

      // Send confirmation
      socket.emit('stream_started', {
        success: true,
        sessionId,
        fallDetectionEnabled: this.fallDetectionEnabled,
        timestamp: Date.now()
      });

      logger.info('✅ Video stream started successfully', {
        sessionId,
        socketId: socket.id
      });

    } catch (error) {
      logger.error('❌ Error starting video stream', {
        socketId: socket.id,
        error: error.message,
        stack: error.stack
      });

      socket.emit('stream_error', {
        error: 'Failed to start video stream',
        message: error.message
      });
    }
  }

  /**
   * Handle incoming video frame
   */
  async handleVideoFrame(socket, data) {
    try {
      const { sessionId, frameData, timestamp, frameIndex } = data;

      if (!sessionId || !frameData) {
        logger.warn('⚠️ Invalid frame data received', { socketId: socket.id });
        return;
      }

      const streamInfo = this.activeStreams.get(sessionId);
      if (!streamInfo) {
        logger.warn('⚠️ Frame received for unknown session', { sessionId });
        return;
      }

      // Update stream info
      streamInfo.frameCount++;
      streamInfo.lastFrameTime = Date.now();

      logger.debug('📹 Video frame received', {
        sessionId,
        frameIndex,
        frameCount: streamInfo.frameCount,
        frameSize: frameData.length,
        timestamp
      });

      // Process frame for fall detection (if enabled)
      if (this.fallDetectionEnabled) {
        await this.processFrameForFallDetection(sessionId, frameData, frameIndex, timestamp);
      }

      // Emit frame received confirmation (optional - can be disabled for performance)
      if (streamInfo.config.requireAck) {
        socket.emit('frame_ack', {
          sessionId,
          frameIndex,
          timestamp: Date.now()
        });
      }

    } catch (error) {
      logger.error('❌ Error handling video frame', {
        sessionId: data.sessionId,
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Process video frame for fall detection
   */
  async processFrameForFallDetection(sessionId, frameData, frameIndex, timestamp) {
    try {
      logger.debug('🤖 Processing frame for fall detection', {
        sessionId,
        frameIndex,
        frameSize: frameData.length
      });

      // Send frame to fall detection model (frameData is already base64)
      const detection = await this.callFallDetectionModel(frameData, sessionId, frameIndex);

      // Handle fall detection result
      if (detection.fallDetected) {
        await this.handleFallDetected(sessionId, detection, frameIndex, timestamp);
      }

    } catch (error) {
      logger.error('❌ Error processing frame for fall detection', {
        sessionId,
        frameIndex,
        error: error.message
      });
    }
  }

  /**
   * Call fall detection model API
   */
  async callFallDetectionModel(frameData, sessionId, frameIndex) {
    try {
      // Construct the API URL
      const apiUrl = this.ec2ModelIp 
        ? `http://${this.ec2ModelIp}/detect`
        : `${this.pythonModelUrl}/detect`;

      // Ensure frameData has proper data URL format
      let formattedFrameData = frameData;
      if (!frameData.startsWith('data:image/')) {
        formattedFrameData = `data:image/jpeg;base64,${frameData}`;
      }

      // Prepare request payload according to API specification
      const requestPayload = {
        frame: formattedFrameData,
        resize: true,
        width: 980,
        height: 740
      };

      logger.debug('🤖 Sending frame to fall detection API', {
        sessionId,
        frameIndex,
        apiUrl,
        frameSize: frameData.length
      });

      const response = await axios.post(
        apiUrl,
        requestPayload,
        {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 10000 // 10 second timeout as recommended
        }
      );

      const result = response.data;

      logger.debug('🤖 Fall detection API response', {
        sessionId,
        frameIndex,
        success: result.success,
        fallDetected: result.fall_detected,
        detectionsCount: result.detections?.length || 0
      });

      // Extract highest confidence detection if available
      let highestConfidence = 0;
      let mainDetection = null;
      
      if (result.detections && result.detections.length > 0) {
        mainDetection = result.detections.reduce((prev, current) => 
          (current.confidence > prev.confidence) ? current : prev
        );
        highestConfidence = mainDetection.confidence;
      }

      return {
        fallDetected: result.fall_detected || false,
        confidence: highestConfidence,
        detections: result.detections || [],
        boundingBox: mainDetection?.bbox || null,
        aspectRatio: mainDetection?.aspect_ratio || null,
        timestamp: result.timestamp,
        success: result.success
      };

    } catch (error) {
      const apiUrl = this.ec2ModelIp 
        ? `http://${this.ec2ModelIp}/detect`
        : `${this.pythonModelUrl}/detect`;

      logger.error('❌ Error calling fall detection API', {
        sessionId,
        frameIndex,
        error: error.message,
        url: apiUrl,
        status: error.response?.status,
        statusText: error.response?.statusText,
        responseData: error.response?.data
      });

      return {
        fallDetected: false,
        confidence: 0,
        detections: [],
        error: error.message,
        success: false
      };
    }
  }

  /**
   * Handle fall detection alert
   */
  async handleFallDetected(sessionId, detection, frameIndex, timestamp) {
    try {
      const streamInfo = this.activeStreams.get(sessionId);
      if (!streamInfo) return;

      logger.warn('🚨 FALL DETECTED!', {
        sessionId,
        frameIndex,
        confidence: detection.confidence,
        detectionsCount: detection.detections?.length || 0,
        aspectRatio: detection.aspectRatio,
        eventId: streamInfo.eventId,
        timestamp,
        apiTimestamp: detection.timestamp
      });

      // Mark fall as detected to prevent spam
      streamInfo.fallDetected = true;

      // Send alert to frontend
      this.io.to(`stream_${sessionId}`).emit('fall_detected', {
        sessionId,
        eventId: streamInfo.eventId,
        detection: {
          confidence: detection.confidence,
          boundingBox: detection.boundingBox,
          detections: detection.detections,
          aspectRatio: detection.aspectRatio,
          frameIndex,
          timestamp,
          apiTimestamp: detection.timestamp
        },
        alert: {
          title: '🚨 Fall Detected!',
          message: `A fall has been detected in the video stream with ${(detection.confidence || 0).toFixed(1)}% confidence. ${detection.detections?.length || 0} person(s) detected.`,
          severity: 'critical',
          timestamp: Date.now()
        }
      });

      // Optional: Send push notification to event subscribers
      if (streamInfo.eventId) {
        try {
          const pushNotificationService = require('./pushNotificationService');
          await pushNotificationService.sendToEvent(streamInfo.eventId, {
            title: '🚨 Fall Alert',
            body: `Fall detected in live video stream with ${(detection.confidence || 0).toFixed(1)}% confidence. ${detection.detections?.length || 0} person(s) detected.`,
            tag: 'fall-detection',
            requireInteraction: true,
            data: {
              type: 'fall_detection',
              sessionId,
              eventId: streamInfo.eventId,
              confidence: detection.confidence,
              detectionsCount: detection.detections?.length || 0,
              aspectRatio: detection.aspectRatio,
              timestamp,
              apiTimestamp: detection.timestamp
            }
          });

          logger.info('📲 Fall detection push notification sent', {
            sessionId,
            eventId: streamInfo.eventId
          });
        } catch (pushError) {
          logger.error('❌ Error sending fall detection push notification', {
            error: pushError.message
          });
        }
      }

    } catch (error) {
      logger.error('❌ Error handling fall detection', {
        sessionId,
        error: error.message
      });
    }
  }

  /**
   * Handle stream stop
   */
  async handleStreamStop(socket, data) {
    try {
      const { sessionId } = data;
      
      logger.info('🛑 Stopping video stream', {
        socketId: socket.id,
        sessionId
      });

      // Clean up stream data
      const streamInfo = this.activeStreams.get(sessionId);
      if (streamInfo) {
        const duration = Date.now() - streamInfo.startTime;
        
        logger.info('📊 Stream statistics', {
          sessionId,
          duration: `${(duration / 1000).toFixed(1)}s`,
          frameCount: streamInfo.frameCount,
          avgFps: streamInfo.frameCount / (duration / 1000),
          fallDetected: streamInfo.fallDetected
        });

        this.activeStreams.delete(sessionId);
      }

      // Clean up frame buffer
      this.frameBuffer.delete(sessionId);

      // Leave session room
      socket.leave(`stream_${sessionId}`);

      // Clean up temporary files for this session
      await this.cleanupSessionFiles(sessionId);

      socket.emit('stream_stopped', {
        success: true,
        sessionId,
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('❌ Error stopping video stream', {
        sessionId: data.sessionId,
        error: error.message
      });
    }
  }

  /**
   * Handle client disconnection
   */
  handleDisconnection(socket, reason) {
    logger.info('🔌 Client disconnected', {
      socketId: socket.id,
      reason
    });

    // Find and clean up any active streams for this socket
    for (const [sessionId, streamInfo] of this.activeStreams.entries()) {
      if (streamInfo.socketId === socket.id) {
        logger.info('🧹 Cleaning up stream for disconnected client', {
          sessionId,
          socketId: socket.id
        });

        this.activeStreams.delete(sessionId);
        this.frameBuffer.delete(sessionId);
        this.cleanupSessionFiles(sessionId);
      }
    }
  }

  /**
   * Initialize temporary directory for video frames
   */
  async initializeTempDirectory() {
    try {
      await fs.ensureDir(this.tempDir);
      logger.info('📁 Temporary directory initialized', { tempDir: this.tempDir });
    } catch (error) {
      logger.error('❌ Error initializing temporary directory', {
        tempDir: this.tempDir,
        error: error.message
      });
    }
  }

  /**
   * Clean up temporary files for a session
   */
  async cleanupSessionFiles(sessionId) {
    try {
      const files = await fs.readdir(this.tempDir);
      const sessionFiles = files.filter(file => file.startsWith(`${sessionId}_`));
      
      for (const file of sessionFiles) {
        await fs.remove(path.join(this.tempDir, file));
      }

      if (sessionFiles.length > 0) {
        logger.debug('🧹 Cleaned up session files', {
          sessionId,
          fileCount: sessionFiles.length
        });
      }
    } catch (error) {
      logger.error('❌ Error cleaning up session files', {
        sessionId,
        error: error.message
      });
    }
  }

  /**
   * Get streaming statistics
   */
  getStats() {
    const stats = {
      activeStreams: this.activeStreams.size,
      totalFrameBuffers: this.frameBuffer.size,
      fallDetectionEnabled: this.fallDetectionEnabled,
      streams: []
    };

    for (const [sessionId, streamInfo] of this.activeStreams.entries()) {
      const duration = Date.now() - streamInfo.startTime;
      stats.streams.push({
        sessionId,
        eventId: streamInfo.eventId,
        duration: Math.round(duration / 1000),
        frameCount: streamInfo.frameCount,
        avgFps: streamInfo.frameCount / (duration / 1000),
        fallDetected: streamInfo.fallDetected,
        lastFrameTime: streamInfo.lastFrameTime
      });
    }

    return stats;
  }

  /**
   * Check fall detection API health
   */
  async checkFallDetectionHealth() {
    try {
      const apiUrl = this.ec2ModelIp 
        ? `http://${this.ec2ModelIp}/health`
        : `${this.pythonModelUrl}/health`;

      logger.info('🏥 Checking fall detection API health', { apiUrl });

      const response = await axios.get(apiUrl, {
        timeout: 5000 // 5 second timeout
      });

      const result = {
        healthy: response.status === 200,
        status: response.data.status,
        modelLoaded: response.data.model_loaded,
        timestamp: response.data.timestamp,
        apiUrl,
        responseTime: Date.now()
      };

      logger.info('✅ Fall detection API health check result', result);
      return result;

    } catch (error) {
      const apiUrl = this.ec2ModelIp 
        ? `http://${this.ec2ModelIp}/health`
        : `${this.pythonModelUrl}/health`;

      logger.error('❌ Fall detection API health check failed', {
        apiUrl,
        error: error.message,
        status: error.response?.status,
        statusText: error.response?.statusText
      });

      return {
        healthy: false,
        error: error.message,
        status: error.response?.status || 'CONNECTION_ERROR',
        apiUrl,
        responseTime: Date.now()
      };
    }
  }

  /**
   * Manual test fall detection (for testing purposes)
   */
  async testFallDetection(sessionId) {
    try {
      if (!this.activeStreams.has(sessionId)) {
        throw new Error('Session not found');
      }

      // Simulate fall detection with new data structure
      await this.handleFallDetected(
        sessionId,
        {
          fallDetected: true,
          confidence: 95.0,
          detections: [{
            class: 'person',
            confidence: 95.0,
            bbox: { x1: 100, y1: 100, x2: 300, y2: 400, width: 200, height: 300 },
            is_fallen: true,
            aspect_ratio: 0.67
          }],
          boundingBox: { x1: 100, y1: 100, x2: 300, y2: 400, width: 200, height: 300 },
          aspectRatio: 0.67,
          timestamp: new Date().toISOString(),
          success: true
        },
        999, // test frame index
        Date.now()
      );

      return { success: true, message: 'Test fall detection triggered' };
    } catch (error) {
      logger.error('❌ Error testing fall detection', {
        sessionId,
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = new VideoStreamingService();
