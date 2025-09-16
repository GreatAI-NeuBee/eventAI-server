const express = require('express');
const { body, validationResult } = require('express-validator');
const winston = require('winston');

const rdsService = require('../services/rdsService');
const aiModelService = require('../services/aiModelService');
const notificationService = require('../services/notificationService');
const { AppError, asyncHandler } = require('../utils/errorHandler');

const router = express.Router();

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'simulation-controller' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Validation middleware for running simulation
const validateRunSimulation = [
  body('simulationId')
    .isString()
    .matches(/^sim_[a-f0-9\-]{36}$/)
    .withMessage('Invalid simulation ID format'),
  body('parameters')
    .optional()
    .isObject()
    .withMessage('Parameters must be an object'),
  body('parameters.crowdDensityThreshold')
    .optional()
    .isFloat({ min: 0.1, max: 1.0 })
    .withMessage('Crowd density threshold must be between 0.1 and 1.0'),
  body('parameters.simulationDuration')
    .optional()
    .isInt({ min: 60, max: 14400 })
    .withMessage('Simulation duration must be between 60 and 14400 seconds'),
  body('parameters.weatherConditions')
    .optional()
    .isIn(['sunny', 'rainy', 'cloudy', 'windy'])
    .withMessage('Weather conditions must be one of: sunny, rainy, cloudy, windy'),
  body('parameters.emergencyScenarios')
    .optional()
    .isArray()
    .withMessage('Emergency scenarios must be an array')
];

/**
 * POST /simulations/run
 * Triggers AI model simulation for a specific simulation ID
 */
router.post('/run', validateRunSimulation, asyncHandler(async (req, res) => {
  // Check for validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new AppError('Validation failed', 400, errors.array());
  }

  const { simulationId, parameters = {} } = req.body;

  logger.info('Starting simulation', { simulationId, parameters });

  try {
    // Get simulation data from RDS
    const simulation = await rdsService.getSimulationById(simulationId);
    if (!simulation) {
      throw new AppError('Simulation not found', 404);
    }

    // Check if simulation is already running
    if (simulation.status === 'RUNNING') {
      throw new AppError('Simulation is already running', 409);
    }

    if (simulation.status === 'COMPLETED') {
      throw new AppError('Simulation has already been completed', 409);
    }

    // Update simulation status to RUNNING
    await rdsService.updateSimulationStatus(simulationId, 'RUNNING', {
      startedAt: new Date(),
      parameters
    });

    // Start AI model simulation asynchronously
    aiModelService.runSimulation(simulationId, simulation.eventId, parameters)
      .then(async (results) => {
        logger.info('Simulation completed successfully', { simulationId });
        
        // Update simulation with results
        await rdsService.updateSimulationStatus(simulationId, 'COMPLETED', {
          completedAt: new Date(),
          results
        });

        // Send notification if results contain recommendations
        if (results.recommendations && results.recommendations.length > 0) {
          try {
            await notificationService.sendWhatsAppAlert(simulationId, results.recommendations);
            logger.info('WhatsApp notification sent', { simulationId });
          } catch (notificationError) {
            logger.error('Failed to send WhatsApp notification', {
              simulationId,
              error: notificationError.message
            });
          }
        }
      })
      .catch(async (error) => {
        logger.error('Simulation failed', { simulationId, error: error.message });
        
        // Update simulation status to FAILED
        await rdsService.updateSimulationStatus(simulationId, 'FAILED', {
          failedAt: new Date(),
          error: error.message
        });
      });

    res.status(202).json({
      success: true,
      data: {
        simulationId,
        status: 'RUNNING',
        message: 'Simulation started successfully'
      }
    });

  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error starting simulation', { simulationId, error: error.message });
    throw new AppError('Failed to start simulation', 500, error.message);
  }
}));

/**
 * GET /simulations/:simulationId/status
 * Retrieves the current status of a simulation
 */
router.get('/:simulationId/status', asyncHandler(async (req, res) => {
  const { simulationId } = req.params;

  if (!simulationId || !simulationId.startsWith('sim_')) {
    throw new AppError('Invalid simulation ID format', 400);
  }

  logger.info('Checking simulation status', { simulationId });

  try {
    const simulation = await rdsService.getSimulationById(simulationId);
    
    if (!simulation) {
      throw new AppError('Simulation not found', 404);
    }

    const statusData = {
      simulationId,
      status: simulation.status,
      createdAt: simulation.createdAt,
      updatedAt: simulation.updatedAt
    };

    // Add additional timestamps based on status
    if (simulation.startedAt) {
      statusData.startedAt = simulation.startedAt;
    }
    if (simulation.completedAt) {
      statusData.completedAt = simulation.completedAt;
      statusData.duration = Math.round((new Date(simulation.completedAt) - new Date(simulation.startedAt)) / 1000);
    }
    if (simulation.failedAt) {
      statusData.failedAt = simulation.failedAt;
      statusData.error = simulation.error;
    }

    // Add progress information if available
    if (simulation.progress) {
      statusData.progress = simulation.progress;
    }

    res.status(200).json({
      success: true,
      data: statusData
    });

  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error checking simulation status', { simulationId, error: error.message });
    throw new AppError('Failed to retrieve simulation status', 500, error.message);
  }
}));

/**
 * GET /simulations/:simulationId/results
 * Retrieves simulation results if completed
 */
router.get('/:simulationId/results', asyncHandler(async (req, res) => {
  const { simulationId } = req.params;

  if (!simulationId || !simulationId.startsWith('sim_')) {
    throw new AppError('Invalid simulation ID format', 400);
  }

  logger.info('Retrieving simulation results', { simulationId });

  try {
    const simulation = await rdsService.getSimulationById(simulationId);
    
    if (!simulation) {
      throw new AppError('Simulation not found', 404);
    }

    if (simulation.status !== 'COMPLETED') {
      throw new AppError(`Simulation is not completed. Current status: ${simulation.status}`, 409);
    }

    if (!simulation.results) {
      throw new AppError('Simulation results not available', 404);
    }

    // Get event details for context
    const event = await rdsService.getEventById(simulation.eventId);

    const responseData = {
      simulationId,
      eventId: simulation.eventId,
      eventName: event?.name || 'Unknown Event',
      status: simulation.status,
      completedAt: simulation.completedAt,
      duration: Math.round((new Date(simulation.completedAt) - new Date(simulation.startedAt)) / 1000),
      results: simulation.results
    };

    res.status(200).json({
      success: true,
      data: responseData
    });

  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error retrieving simulation results', { simulationId, error: error.message });
    throw new AppError('Failed to retrieve simulation results', 500, error.message);
  }
}));

/**
 * GET /simulations/:simulationId
 * Retrieves complete simulation information
 */
router.get('/:simulationId', asyncHandler(async (req, res) => {
  const { simulationId } = req.params;

  if (!simulationId || !simulationId.startsWith('sim_')) {
    throw new AppError('Invalid simulation ID format', 400);
  }

  logger.info('Retrieving simulation details', { simulationId });

  try {
    const simulation = await rdsService.getSimulationById(simulationId);
    
    if (!simulation) {
      throw new AppError('Simulation not found', 404);
    }

    // Get associated event details
    const event = await rdsService.getEventById(simulation.eventId);

    const responseData = {
      ...simulation,
      event: event ? {
        eventId: event.eventId,
        name: event.name,
        venue: event.venue,
        eventDate: event.eventDate,
        eventType: event.eventType
      } : null
    };

    res.status(200).json({
      success: true,
      data: responseData
    });

  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error retrieving simulation details', { simulationId, error: error.message });
    throw new AppError('Failed to retrieve simulation details', 500, error.message);
  }
}));

/**
 * DELETE /simulations/:simulationId
 * Cancels a running simulation or deletes simulation data
 */
router.delete('/:simulationId', asyncHandler(async (req, res) => {
  const { simulationId } = req.params;

  if (!simulationId || !simulationId.startsWith('sim_')) {
    throw new AppError('Invalid simulation ID format', 400);
  }

  logger.info('Canceling/deleting simulation', { simulationId });

  try {
    const simulation = await rdsService.getSimulationById(simulationId);
    
    if (!simulation) {
      throw new AppError('Simulation not found', 404);
    }

    if (simulation.status === 'RUNNING') {
      // Cancel the running simulation
      await aiModelService.cancelSimulation(simulationId);
      await rdsService.updateSimulationStatus(simulationId, 'CANCELLED', {
        cancelledAt: new Date()
      });
      
      res.status(200).json({
        success: true,
        message: 'Simulation cancelled successfully'
      });
    } else {
      // Delete simulation data
      await rdsService.deleteSimulation(simulationId);
      
      res.status(200).json({
        success: true,
        message: 'Simulation deleted successfully'
      });
    }

  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error('Error canceling/deleting simulation', { simulationId, error: error.message });
    throw new AppError('Failed to cancel/delete simulation', 500, error.message);
  }
}));

/**
 * GET /simulations
 * Lists simulations with optional filtering
 */
router.get('/', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 100);
  const offset = (page - 1) * limit;
  const status = req.query.status;
  const eventId = req.query.eventId;

  logger.info('Listing simulations', { page, limit, status, eventId });

  try {
    const filters = {};
    if (status) filters.status = status;
    if (eventId) filters.eventId = eventId;

    const { simulations, total } = await rdsService.getSimulations(limit, offset, filters);

    res.status(200).json({
      success: true,
      data: {
        simulations,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        },
        filters
      }
    });

  } catch (error) {
    logger.error('Error listing simulations', { error: error.message });
    throw new AppError('Failed to retrieve simulations', 500, error.message);
  }
}));

module.exports = router;

