const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 's3-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'event-ai-storage';

class S3Service {
  /**
   * Uploads JSON data to S3
   * @param {string} key - S3 object key
   * @param {Object} data - JSON data to upload
   * @returns {Promise<string>} - S3 object URL
   */
  async uploadJson(key, data) {
    try {
      logger.info('Uploading JSON to S3', { key, bucket: BUCKET_NAME });

      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: JSON.stringify(data, null, 2),
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
        Metadata: {
          'uploaded-by': 'event-ai-server',
          'upload-timestamp': new Date().toISOString()
        }
      });

      await s3Client.send(command);
      
      const objectUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
      logger.info('JSON uploaded successfully', { key, objectUrl });
      
      return objectUrl;
    } catch (error) {
      logger.error('Error uploading JSON to S3', { key, error: error.message });
      throw new Error(`Failed to upload JSON to S3: ${error.message}`);
    }
  }

  /**
   * Uploads a file buffer to S3
   * @param {string} key - S3 object key
   * @param {Buffer} buffer - File buffer
   * @param {string} contentType - MIME type
   * @returns {Promise<string>} - S3 object URL
   */
  async uploadFile(key, buffer, contentType = 'application/octet-stream') {
    try {
      logger.info('Uploading file to S3', { key, bucket: BUCKET_NAME, contentType });

      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
        Metadata: {
          'uploaded-by': 'event-ai-server',
          'upload-timestamp': new Date().toISOString()
        }
      });

      await s3Client.send(command);
      
      const objectUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
      logger.info('File uploaded successfully', { key, objectUrl });
      
      return objectUrl;
    } catch (error) {
      logger.error('Error uploading file to S3', { key, error: error.message });
      throw new Error(`Failed to upload file to S3: ${error.message}`);
    }
  }

  /**
   * Downloads and parses JSON from S3
   * @param {string} key - S3 object key
   * @returns {Promise<Object>} - Parsed JSON data
   */
  async getJson(key) {
    try {
      logger.info('Downloading JSON from S3', { key, bucket: BUCKET_NAME });

      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      });

      const response = await s3Client.send(command);
      const bodyContents = await this.streamToString(response.Body);
      const jsonData = JSON.parse(bodyContents);
      
      logger.info('JSON downloaded successfully', { key });
      return jsonData;
    } catch (error) {
      logger.error('Error downloading JSON from S3', { key, error: error.message });
      throw new Error(`Failed to download JSON from S3: ${error.message}`);
    }
  }

  /**
   * Downloads a file from S3
   * @param {string} key - S3 object key
   * @returns {Promise<Buffer>} - File buffer
   */
  async getFile(key) {
    try {
      logger.info('Downloading file from S3', { key, bucket: BUCKET_NAME });

      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      });

      const response = await s3Client.send(command);
      const buffer = await this.streamToBuffer(response.Body);
      
      logger.info('File downloaded successfully', { key, size: buffer.length });
      return buffer;
    } catch (error) {
      logger.error('Error downloading file from S3', { key, error: error.message });
      throw new Error(`Failed to download file from S3: ${error.message}`);
    }
  }

  /**
   * Deletes a single object from S3
   * @param {string} key - S3 object key
   * @returns {Promise<void>}
   */
  async deleteObject(key) {
    try {
      logger.info('Deleting object from S3', { key, bucket: BUCKET_NAME });

      const command = new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      });

      await s3Client.send(command);
      logger.info('Object deleted successfully', { key });
    } catch (error) {
      logger.error('Error deleting object from S3', { key, error: error.message });
      throw new Error(`Failed to delete object from S3: ${error.message}`);
    }
  }

  /**
   * Deletes multiple objects from S3
   * @param {string[]} keys - Array of S3 object keys
   * @returns {Promise<void>}
   */
  async deleteObjects(keys) {
    if (!keys || keys.length === 0) {
      return;
    }

    try {
      logger.info('Deleting multiple objects from S3', { keys, bucket: BUCKET_NAME });

      const objects = keys.map(key => ({ Key: key }));
      
      const command = new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: {
          Objects: objects,
          Quiet: false
        }
      });

      const response = await s3Client.send(command);
      
      if (response.Errors && response.Errors.length > 0) {
        logger.warn('Some objects failed to delete', { errors: response.Errors });
      }
      
      logger.info('Objects deleted successfully', { 
        deleted: response.Deleted?.length || 0,
        errors: response.Errors?.length || 0
      });
    } catch (error) {
      logger.error('Error deleting objects from S3', { keys, error: error.message });
      throw new Error(`Failed to delete objects from S3: ${error.message}`);
    }
  }

  /**
   * Generates a pre-signed URL for direct upload
   * @param {string} key - S3 object key
   * @param {number} expiresIn - Expiration time in seconds (default: 3600)
   * @returns {Promise<string>} - Pre-signed URL
   */
  async getPresignedUploadUrl(key, expiresIn = 3600) {
    try {
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      
      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        ServerSideEncryption: 'AES256'
      });

      const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn });
      
      logger.info('Generated presigned upload URL', { key, expiresIn });
      return presignedUrl;
    } catch (error) {
      logger.error('Error generating presigned upload URL', { key, error: error.message });
      throw new Error(`Failed to generate presigned upload URL: ${error.message}`);
    }
  }

  /**
   * Generates a pre-signed URL for direct download
   * @param {string} key - S3 object key
   * @param {number} expiresIn - Expiration time in seconds (default: 3600)
   * @returns {Promise<string>} - Pre-signed URL
   */
  async getPresignedDownloadUrl(key, expiresIn = 3600) {
    try {
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      });

      const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn });
      
      logger.info('Generated presigned download URL', { key, expiresIn });
      return presignedUrl;
    } catch (error) {
      logger.error('Error generating presigned download URL', { key, error: error.message });
      throw new Error(`Failed to generate presigned download URL: ${error.message}`);
    }
  }

  /**
   * Checks if an object exists in S3
   * @param {string} key - S3 object key
   * @returns {Promise<boolean>} - True if object exists
   */
  async objectExists(key) {
    try {
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      });

      await s3Client.send(command);
      return true;
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      logger.error('Error checking object existence', { key, error: error.message });
      throw new Error(`Failed to check object existence: ${error.message}`);
    }
  }

  /**
   * Helper method to convert stream to string
   * @param {ReadableStream} stream - Stream to convert
   * @returns {Promise<string>} - String content
   */
  async streamToString(stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  /**
   * Helper method to convert stream to buffer
   * @param {ReadableStream} stream - Stream to convert
   * @returns {Promise<Buffer>} - Buffer content
   */
  async streamToBuffer(stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
}

module.exports = new S3Service();

