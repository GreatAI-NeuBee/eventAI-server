const express = require('express');
const winston = require('winston');

const eventService = require('../services/eventService');
const predictionService = require('../services/predictionService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

const router = express.Router();

/**
 * Formats forecast and prediction data for frontend line graph comparison
 */
function formatForecastVsPredictionData(event) {
  const forecastResult = event.forecastResult;
  const predictResult = event.predictResult;
  
  // Extract gates information from forecast
  const gates = forecastResult.summary?.gates || [];
  const forecastPredictions = forecastResult.summary?.predictions || [];
  
  // Create timeline from forecast period
  const forecastPeriod = forecastResult.summary?.forecastPeriod;
  const startTime = new Date(forecastPeriod?.start || event.dateOfEventStart);
  const endTime = new Date(forecastPeriod?.end || event.dateOfEventEnd);
  
  // Generate 5-minute intervals for the timeline
  const timeline = [];
  const current = new Date(startTime);
  while (current <= endTime) {
    timeline.push(new Date(current));
    current.setMinutes(current.getMinutes() + 5);
  }
  
  // Format data for each gate
  const gateData = gates.map(gateId => {
    const forecastData = forecastPredictions.find(p => p.gate === gateId) || {};
    
    // Create forecast line (complete data)
    const forecastLine = timeline.map(time => ({
      timestamp: time.toISOString(),
      time: time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
      // Use average prediction as baseline, you might want to use actual forecast data if available
      forecastCount: forecastData.avgPrediction || 0,
      capacity: forecastData.capacity || 0
    }));
    
    // Create prediction line (partial data that builds up over time)
    const predictionLine = [];
    if (predictResult && predictResult.predictions) {
      // Map gate IDs: forecast uses "1","2","A","B" while predictions use "gate_1","gate_2","gate_3"
      const gateMapping = {
        '1': ['gate_1', '1'],
        '2': ['gate_2', '2'], 
        'A': ['gate_3', 'A', 'gate_A'],
        'B': ['gate_4', 'B', 'gate_B']
      };
      
      // Find predictions for this gate using flexible matching
      const gatePredictions = predictResult.predictions.filter(p => {
        const possibleIds = gateMapping[gateId] || [gateId];
        return possibleIds.some(id => 
          p.gate_id === id || p.gate === id || p.gate_id === gateId || p.gate === gateId
        );
      });
      
      gatePredictions.forEach(prediction => {
        if (prediction.forecast_next_5_min) {
          predictionLine.push({
            timestamp: prediction.timestamp || new Date().toISOString(),
            time: new Date(prediction.timestamp || new Date()).toLocaleTimeString('en-US', { 
              hour12: false, 
              hour: '2-digit', 
              minute: '2-digit' 
            }),
            predictedCount: prediction.forecast_next_5_min.predicted_people_count || 0,
            congestionLevel: prediction.forecast_next_5_min.predicted_congestion_level || 'Unknown',
            riskScore: prediction.forecast_next_5_min.risk_score || 0,
            currentCount: prediction.current_people_count || 0,
            confidenceScore: prediction.confidence_score || 0
          });
        }
      });
    }
    
    return {
      gateId,
      gateName: `Gate ${gateId}`,
      capacity: forecastData.capacity || 0,
      forecast: {
        complete: true,
        dataPoints: forecastLine,
        avgPrediction: forecastData.avgPrediction || 0,
        peakPrediction: forecastData.peakPrediction || 0
      },
      prediction: {
        complete: predictionLine.length >= timeline.length,
        dataPoints: predictionLine,
        lastUpdated: predictionLine.length > 0 ? predictionLine[predictionLine.length - 1].timestamp : null,
        progress: timeline.length > 0 ? Math.round((predictionLine.length / timeline.length) * 100) : 0
      }
    };
  });
  
  return {
    eventId: event.eventId,
    eventName: event.name,
    eventPeriod: {
      start: startTime.toISOString(),
      end: endTime.toISOString(),
      duration: Math.round((endTime - startTime) / (1000 * 60)) // minutes
    },
    timeline: {
      intervals: timeline.map(t => ({
        timestamp: t.toISOString(),
        time: t.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
      })),
      intervalMinutes: 5,
      totalIntervals: timeline.length
    },
    gates: gateData,
    summary: {
      totalGates: gates.length,
      forecastAvailable: !!forecastResult,
      predictionAvailable: !!predictResult,
      lastPredictionUpdate: predictResult ? (predictResult.processedAt || predictResult.timestamp || event.updatedAt) : null,
      overallProgress: gateData.length > 0 ? Math.round(gateData.reduce((sum, gate) => sum + gate.prediction.progress, 0) / gateData.length) : 0
    }
  };
}

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'prediction-controller' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

/**
 * POST /prediction/:eventId
 * Gets real-time prediction for an event
 */
router.post('/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  logger.info('Getting prediction for event', { eventId });

  try {
    // Get event with forecast_result
    const event = await eventService.getEventById(eventId);
    
    if (!event) {
      return res.status(404).json({
        success: false,
        error: {
          status: 'fail',
          message: 'Event not found',
          code: 'EVENT_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    // Check if event has forecast_result
    if (!event.forecastResult) {
      return res.status(400).json({
        success: false,
        error: {
          status: 'fail',
          message: 'Event must have forecast_result before getting predictions',
          code: 'FORECAST_REQUIRED'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    // Get prediction from the model
    const predictionResult = await predictionService.getPrediction(event);

    // Check if prediction failed
    if (predictionResult.error) {
      logger.warn('Prediction failed for event', { 
        eventId, 
        error: predictionResult.message 
      });
      
      return res.status(503).json({
        success: false,
        error: {
          status: 'error',
          message: 'Prediction service unavailable',
          details: predictionResult.message,
          code: 'PREDICTION_SERVICE_ERROR'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    // Update event with prediction result
    const updatedEvent = await eventService.updateEvent(eventId, {
      predictResult: predictionResult
    });

    logger.info('Prediction completed and saved', { 
      eventId,
      predictionsCount: predictionResult.predictions?.length || 0
    });

    res.status(200).json({
      success: true,
      data: {
        eventId,
        predictionResult,
        event: updatedEvent,
        updatedAt: new Date().toISOString()
      },
      message: 'Prediction completed successfully'
    });

  } catch (error) {
    logger.error('Error getting prediction', { eventId, error: error.message });
    throw new AppError('Failed to get prediction', 500, error.message);
  }
}));

/**
 * GET /prediction/:eventId
 * Gets the latest prediction result for an event
 */
router.get('/:eventId', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  logger.info('Retrieving prediction result for event', { eventId });

  try {
    const event = await eventService.getEventById(eventId);
    
    if (!event) {
      return res.status(404).json({
        success: false,
        error: {
          status: 'fail',
          message: 'Event not found',
          code: 'EVENT_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        eventId,
        predictResult: event.predictResult,
        hasPrediction: !!event.predictResult,
        hasForecast: !!event.forecastResult,
        lastUpdated: event.updatedAt
      },
      message: 'Prediction result retrieved successfully'
    });

  } catch (error) {
    logger.error('Error retrieving prediction result', { eventId, error: error.message });
    throw new AppError('Failed to retrieve prediction result', 500, error.message);
  }
}));

/**
 * GET /prediction/health/model
 * Checks the health of the prediction model service
 */
router.get('/health/model', asyncHandler(async (req, res) => {
  logger.info('Checking prediction model health');

  try {
    const healthResult = await predictionService.healthCheck();

    const statusCode = healthResult.healthy ? 200 : 503;

    res.status(statusCode).json({
      success: healthResult.healthy,
      data: healthResult,
      message: healthResult.healthy 
        ? 'Prediction model service is healthy' 
        : 'Prediction model service is unavailable'
    });

  } catch (error) {
    logger.error('Error checking prediction model health', { error: error.message });
    
    res.status(503).json({
      success: false,
      error: {
        status: 'error',
        message: 'Unable to check prediction model service health',
        code: 'HEALTH_CHECK_FAILED'
      },
      timestamp: new Date().toISOString(),
      requestId: req.headers['x-request-id'] || 'unknown'
    });
  }
}));

/**
 * GET /prediction/:eventId/comparison
 * Gets formatted comparison data between forecast and prediction results for line graphs
 */
router.get('/:eventId/comparison', asyncHandler(async (req, res) => {
  const { eventId } = req.params;

  logger.info('Getting forecast vs prediction comparison data', { eventId });

  try {
    const event = await eventService.getEventById(eventId);
    
    if (!event) {
      return res.status(404).json({
        success: false,
        error: {
          status: 'fail',
          message: 'Event not found',
          code: 'EVENT_NOT_FOUND'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    if (!event.forecastResult) {
      return res.status(400).json({
        success: false,
        error: {
          status: 'fail',
          message: 'Event must have forecast_result for comparison',
          code: 'FORECAST_REQUIRED'
        },
        timestamp: new Date().toISOString(),
        requestId: req.headers['x-request-id'] || 'unknown'
      });
    }

    // Format comparison data
    const comparisonData = formatForecastVsPredictionData(event);

    res.status(200).json({
      success: true,
      data: comparisonData,
      message: 'Forecast vs prediction comparison data retrieved successfully'
    });

  } catch (error) {
    logger.error('Error getting comparison data', { eventId, error: error.message });
    throw new AppError('Failed to get comparison data', 500, error.message);
  }
}));

/**
 * GET /prediction/debug/events
 * Debug endpoint to see which events would be selected for prediction updates
 */
router.get('/debug/events', asyncHandler(async (req, res) => {
  logger.info('Debug: Getting events for prediction update');
  
  try {
    const cronService = require('../services/cronService');
    const events = await cronService.getOngoingEvents();
    
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    
    // Also get all events to compare
    const { events: allEvents } = await eventService.getEvents(1000, 0, {});
    
    res.status(200).json({
      success: true,
      data: {
        serverTime: {
          current: now.toISOString(),
          currentLocal: now.toString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          todayStart: todayStart.toISOString(),
          todayEnd: todayEnd.toISOString()
        },
        selectedEvents: events.map(event => ({
          eventId: event.eventId,
          name: event.name,
          dateOfEventStart: event.dateOfEventStart,
          dateOfEventEnd: event.dateOfEventEnd,
          hasForecastResult: !!event.forecastResult,
          status: event.status
        })),
        allActiveEvents: allEvents.map(event => {
          const eventStart = new Date(event.dateOfEventStart);
          const eventEnd = new Date(event.dateOfEventEnd);
          const eventStartDate = new Date(eventStart.getFullYear(), eventStart.getMonth(), eventStart.getDate());
          const todayDate = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate());
          
          return {
            eventId: event.eventId,
            name: event.name,
            dateOfEventStart: event.dateOfEventStart,
            dateOfEventEnd: event.dateOfEventEnd,
            hasForecastResult: !!event.forecastResult,
            status: event.status,
            debugInfo: {
              eventStartDate: eventStartDate.toISOString(),
              todayDate: todayDate.toISOString(),
              isToday: eventStartDate.getTime() === todayDate.getTime(),
              hasNotEnded: now <= eventEnd,
              wouldBeSelected: eventStartDate.getTime() === todayDate.getTime() && !!event.forecastResult && now <= eventEnd
            }
          };
        }),
        totalSelectedEvents: events.length,
        totalActiveEvents: allEvents.length
      },
      message: 'Debug information for prediction events'
    });
  } catch (error) {
    logger.error('Error in debug events endpoint', { error: error.message });
    throw new AppError('Failed to get debug information', 500, error.message);
  }
}));

module.exports = router;
