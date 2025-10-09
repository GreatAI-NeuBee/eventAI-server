/**
 * Timezone Helper Utilities
 * 
 * Provides functions to convert between UTC and Malaysia timezone (UTC+8)
 * 
 * IMPORTANT: Always store timestamps in UTC in the database
 * Use these utilities to convert to Malaysia time for display only
 */

const MALAYSIA_OFFSET_MS = 8 * 60 * 60 * 1000; // 8 hours in milliseconds

/**
 * Convert Malaysia time string to UTC ISO string
 * 
 * @param {string} malaysiaTimeString - Format: "2025-10-09 13:30:00" or "2025-10-09 13:30:00.123"
 * @returns {string} - ISO UTC string: "2025-10-09T05:30:00.000Z"
 * 
 * @example
 * malaysiaToUTC("2025-10-09 13:30:00") // "2025-10-09T05:30:00.000Z"
 * malaysiaToUTC("2025-10-09 13:30:00.500") // "2025-10-09T05:30:00.500Z"
 */
function malaysiaToUTC(malaysiaTimeString) {
  if (!malaysiaTimeString) {
    throw new Error('Malaysia time string is required');
  }

  // Handle both "YYYY-MM-DD HH:mm:ss" and "YYYY-MM-DD HH:mm:ss.SSS"
  const trimmed = malaysiaTimeString.trim();
  const [datePart, timePart] = trimmed.split(' ');
  
  if (!datePart || !timePart) {
    throw new Error(`Invalid Malaysia time format: ${malaysiaTimeString}. Expected: "YYYY-MM-DD HH:mm:ss"`);
  }

  const [year, month, day] = datePart.split('-').map(Number);
  const timeComponents = timePart.split(':');
  
  if (timeComponents.length < 2) {
    throw new Error(`Invalid time format: ${timePart}. Expected: "HH:mm:ss" or "HH:mm:ss.SSS"`);
  }

  const hour = Number(timeComponents[0]);
  const minute = Number(timeComponents[1]);
  const secondParts = timeComponents[2] ? timeComponents[2].split('.') : ['0'];
  const second = Number(secondParts[0]);
  const millisecond = secondParts[1] ? Number(secondParts[1].padEnd(3, '0').slice(0, 3)) : 0;
  
  // Create UTC date by subtracting Malaysia offset
  // Malaysia time is UTC+8, so to get UTC we subtract 8 hours
  const utcDate = new Date(Date.UTC(
    year,
    month - 1,  // Month is 0-indexed in JavaScript
    day,
    hour,
    minute,
    second,
    millisecond
  ) - MALAYSIA_OFFSET_MS);
  
  return utcDate.toISOString();
}

/**
 * Convert UTC ISO string to Malaysia time string
 * 
 * @param {string} utcISOString - Format: "2025-10-09T05:30:00.000Z"
 * @returns {string} - Malaysia time: "2025-10-09 13:30:00"
 * 
 * @example
 * utcToMalaysia("2025-10-09T05:30:00.000Z") // "2025-10-09 13:30:00"
 * utcToMalaysia("2025-10-09T05:30:00.500Z") // "2025-10-09 13:30:00"
 */
function utcToMalaysia(utcISOString) {
  if (!utcISOString) {
    throw new Error('UTC ISO string is required');
  }

  const utcDate = new Date(utcISOString);
  
  if (isNaN(utcDate.getTime())) {
    throw new Error(`Invalid UTC ISO string: ${utcISOString}`);
  }

  const malaysiaDate = new Date(utcDate.getTime() + MALAYSIA_OFFSET_MS);
  
  const year = malaysiaDate.getUTCFullYear();
  const month = String(malaysiaDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(malaysiaDate.getUTCDate()).padStart(2, '0');
  const hours = String(malaysiaDate.getUTCHours()).padStart(2, '0');
  const minutes = String(malaysiaDate.getUTCMinutes()).padStart(2, '0');
  const seconds = String(malaysiaDate.getUTCSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Convert UTC ISO string to Malaysia time string with milliseconds
 * 
 * @param {string} utcISOString - Format: "2025-10-09T05:30:00.000Z"
 * @returns {string} - Malaysia time: "2025-10-09 13:30:00.000"
 * 
 * @example
 * utcToMalaysiaWithMs("2025-10-09T05:30:00.500Z") // "2025-10-09 13:30:00.500"
 */
function utcToMalaysiaWithMs(utcISOString) {
  if (!utcISOString) {
    throw new Error('UTC ISO string is required');
  }

  const utcDate = new Date(utcISOString);
  
  if (isNaN(utcDate.getTime())) {
    throw new Error(`Invalid UTC ISO string: ${utcISOString}`);
  }

  const malaysiaDate = new Date(utcDate.getTime() + MALAYSIA_OFFSET_MS);
  
  const year = malaysiaDate.getUTCFullYear();
  const month = String(malaysiaDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(malaysiaDate.getUTCDate()).padStart(2, '0');
  const hours = String(malaysiaDate.getUTCHours()).padStart(2, '0');
  const minutes = String(malaysiaDate.getUTCMinutes()).padStart(2, '0');
  const seconds = String(malaysiaDate.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(malaysiaDate.getUTCMilliseconds()).padStart(3, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

/**
 * Format UTC timestamp for Malaysia display with timezone label
 * 
 * @param {string} utcISOString - UTC timestamp
 * @returns {string} - Formatted Malaysia time with MYT label
 * 
 * @example
 * formatMalaysiaTime("2025-10-09T05:30:00.000Z") // "2025-10-09 13:30:00 MYT"
 */
function formatMalaysiaTime(utcISOString) {
  return utcToMalaysia(utcISOString) + ' MYT';
}

/**
 * Get current time in Malaysia timezone as string
 * 
 * @returns {string} - Current Malaysia time: "2025-10-09 13:30:00"
 * 
 * @example
 * getCurrentMalaysiaTime() // "2025-10-09 13:30:00"
 */
function getCurrentMalaysiaTime() {
  return utcToMalaysia(new Date().toISOString());
}

/**
 * Get current time in Malaysia timezone as formatted string with MYT label
 * 
 * @returns {string} - Current Malaysia time: "2025-10-09 13:30:00 MYT"
 * 
 * @example
 * getCurrentMalaysiaTimeFormatted() // "2025-10-09 13:30:00 MYT"
 */
function getCurrentMalaysiaTimeFormatted() {
  return formatMalaysiaTime(new Date().toISOString());
}

/**
 * Convert array of forecast/prediction results with Malaysia timestamps to UTC
 * 
 * @param {Array} timeFrames - Array of timeframe objects with 'timestamp' field
 * @returns {Array} - Array with timestamps converted to UTC
 * 
 * @example
 * const malaysiaFrames = [
 *   { timestamp: "2025-10-09 13:30:00", predicted: 100 },
 *   { timestamp: "2025-10-09 13:35:00", predicted: 200 }
 * ];
 * convertTimeFramesToUTC(malaysiaFrames);
 * // [
 * //   { timestamp: "2025-10-09T05:30:00.000Z", predicted: 100 },
 * //   { timestamp: "2025-10-09T05:35:00.000Z", predicted: 200 }
 * // ]
 */
function convertTimeFramesToUTC(timeFrames) {
  if (!Array.isArray(timeFrames)) {
    throw new Error('timeFrames must be an array');
  }

  return timeFrames.map(frame => ({
    ...frame,
    timestamp: malaysiaToUTC(frame.timestamp)
  }));
}

/**
 * Convert array of forecast/prediction results with UTC timestamps to Malaysia time
 * 
 * @param {Array} timeFrames - Array of timeframe objects with 'timestamp' field in UTC
 * @returns {Array} - Array with timestamps converted to Malaysia time
 * 
 * @example
 * const utcFrames = [
 *   { timestamp: "2025-10-09T05:30:00.000Z", predicted: 100 },
 *   { timestamp: "2025-10-09T05:35:00.000Z", predicted: 200 }
 * ];
 * convertTimeFramesToMalaysia(utcFrames);
 * // [
 * //   { timestamp: "2025-10-09 13:30:00", predicted: 100 },
 * //   { timestamp: "2025-10-09 13:35:00", predicted: 200 }
 * // ]
 */
function convertTimeFramesToMalaysia(timeFrames) {
  if (!Array.isArray(timeFrames)) {
    throw new Error('timeFrames must be an array');
  }

  return timeFrames.map(frame => ({
    ...frame,
    timestamp: utcToMalaysia(frame.timestamp)
  }));
}

module.exports = {
  // Constants
  MALAYSIA_OFFSET_MS,
  
  // Core conversion functions
  malaysiaToUTC,
  utcToMalaysia,
  utcToMalaysiaWithMs,
  formatMalaysiaTime,
  
  // Convenience functions
  getCurrentMalaysiaTime,
  getCurrentMalaysiaTimeFormatted,
  
  // Batch conversion functions
  convertTimeFramesToUTC,
  convertTimeFramesToMalaysia
};

