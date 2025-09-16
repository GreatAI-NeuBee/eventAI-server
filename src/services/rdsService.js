const { PrismaClient } = require('@prisma/client');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'rds-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Initialize Prisma client
const prisma = new PrismaClient({
  log: [
    { level: 'query', emit: 'event' },
    { level: 'error', emit: 'event' },
    { level: 'info', emit: 'event' },
    { level: 'warn', emit: 'event' }
  ]
});

// Log Prisma events
prisma.$on('query', (e) => {
  logger.debug('Prisma Query', { query: e.query, params: e.params, duration: e.duration });
});

prisma.$on('error', (e) => {
  logger.error('Prisma Error', { target: e.target, message: e.message });
});

class RDSService {
  constructor() {
    this.prisma = prisma;
  }

  /**
   * Creates a new event record
   * @param {Object} eventData - Event data to create
   * @returns {Promise<Object>} - Created event
   */
  async createEvent(eventData) {
    try {
      logger.info('Creating event in database', { eventId: eventData.eventId });

      const event = await this.prisma.event.create({
        data: {
          eventId: eventData.eventId,
          simulationId: eventData.simulationId,
          name: eventData.name,
          description: eventData.description,
          venue: eventData.venue,
          expectedAttendees: eventData.expectedAttendees,
          eventDate: eventData.eventDate,
          eventType: eventData.eventType,
          s3Keys: eventData.s3Keys || {},
          status: eventData.status,
          createdAt: eventData.createdAt,
          updatedAt: eventData.updatedAt,
          // Create associated simulation record
          simulation: {
            create: {
              simulationId: eventData.simulationId,
              status: 'PENDING',
              createdAt: eventData.createdAt,
              updatedAt: eventData.updatedAt
            }
          }
        },
        include: {
          simulation: true
        }
      });

      logger.info('Event created successfully', { eventId: eventData.eventId });
      return event;
    } catch (error) {
      logger.error('Error creating event', { eventId: eventData.eventId, error: error.message });
      throw new Error(`Failed to create event: ${error.message}`);
    }
  }

  /**
   * Retrieves an event by ID
   * @param {string} eventId - Event ID
   * @returns {Promise<Object|null>} - Event data or null if not found
   */
  async getEventById(eventId) {
    try {
      logger.info('Retrieving event from database', { eventId });

      const event = await this.prisma.event.findUnique({
        where: { eventId },
        include: {
          simulation: true
        }
      });

      if (event) {
        logger.info('Event retrieved successfully', { eventId });
      } else {
        logger.warn('Event not found', { eventId });
      }

      return event;
    } catch (error) {
      logger.error('Error retrieving event', { eventId, error: error.message });
      throw new Error(`Failed to retrieve event: ${error.message}`);
    }
  }

  /**
   * Retrieves events with pagination
   * @param {number} limit - Number of events to retrieve
   * @param {number} offset - Number of events to skip
   * @returns {Promise<{events: Object[], total: number}>} - Events and total count
   */
  async getEvents(limit = 10, offset = 0) {
    try {
      logger.info('Retrieving events with pagination', { limit, offset });

      const [events, total] = await Promise.all([
        this.prisma.event.findMany({
          skip: offset,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            simulation: {
              select: {
                simulationId: true,
                status: true,
                startedAt: true,
                completedAt: true
              }
            }
          }
        }),
        this.prisma.event.count()
      ]);

      logger.info('Events retrieved successfully', { count: events.length, total });
      return { events, total };
    } catch (error) {
      logger.error('Error retrieving events', { error: error.message });
      throw new Error(`Failed to retrieve events: ${error.message}`);
    }
  }

  /**
   * Updates an event
   * @param {string} eventId - Event ID
   * @param {Object} updateData - Data to update
   * @returns {Promise<Object>} - Updated event
   */
  async updateEvent(eventId, updateData) {
    try {
      logger.info('Updating event in database', { eventId });

      const event = await this.prisma.event.update({
        where: { eventId },
        data: {
          ...updateData,
          updatedAt: new Date()
        },
        include: {
          simulation: true
        }
      });

      logger.info('Event updated successfully', { eventId });
      return event;
    } catch (error) {
      logger.error('Error updating event', { eventId, error: error.message });
      throw new Error(`Failed to update event: ${error.message}`);
    }
  }

  /**
   * Deletes an event and associated simulation
   * @param {string} eventId - Event ID
   * @returns {Promise<void>}
   */
  async deleteEvent(eventId) {
    try {
      logger.info('Deleting event from database', { eventId });

      await this.prisma.$transaction(async (prisma) => {
        // Delete associated simulation first
        await prisma.simulation.deleteMany({
          where: { eventId }
        });

        // Delete the event
        await prisma.event.delete({
          where: { eventId }
        });
      });

      logger.info('Event deleted successfully', { eventId });
    } catch (error) {
      logger.error('Error deleting event', { eventId, error: error.message });
      throw new Error(`Failed to delete event: ${error.message}`);
    }
  }

  /**
   * Retrieves a simulation by ID
   * @param {string} simulationId - Simulation ID
   * @returns {Promise<Object|null>} - Simulation data or null if not found
   */
  async getSimulationById(simulationId) {
    try {
      logger.info('Retrieving simulation from database', { simulationId });

      const simulation = await this.prisma.simulation.findUnique({
        where: { simulationId },
        include: {
          event: {
            select: {
              eventId: true,
              name: true,
              venue: true,
              eventDate: true,
              eventType: true
            }
          }
        }
      });

      if (simulation) {
        logger.info('Simulation retrieved successfully', { simulationId });
      } else {
        logger.warn('Simulation not found', { simulationId });
      }

      return simulation;
    } catch (error) {
      logger.error('Error retrieving simulation', { simulationId, error: error.message });
      throw new Error(`Failed to retrieve simulation: ${error.message}`);
    }
  }

  /**
   * Updates simulation status and metadata
   * @param {string} simulationId - Simulation ID
   * @param {string} status - New status
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} - Updated simulation
   */
  async updateSimulationStatus(simulationId, status, metadata = {}) {
    try {
      logger.info('Updating simulation status', { simulationId, status });

      const updateData = {
        status,
        updatedAt: new Date(),
        ...metadata
      };

      const simulation = await this.prisma.simulation.update({
        where: { simulationId },
        data: updateData
      });

      logger.info('Simulation status updated successfully', { simulationId, status });
      return simulation;
    } catch (error) {
      logger.error('Error updating simulation status', { simulationId, status, error: error.message });
      throw new Error(`Failed to update simulation status: ${error.message}`);
    }
  }

  /**
   * Retrieves simulations with pagination and filtering
   * @param {number} limit - Number of simulations to retrieve
   * @param {number} offset - Number of simulations to skip
   * @param {Object} filters - Filter criteria
   * @returns {Promise<{simulations: Object[], total: number}>} - Simulations and total count
   */
  async getSimulations(limit = 10, offset = 0, filters = {}) {
    try {
      logger.info('Retrieving simulations with pagination', { limit, offset, filters });

      const whereClause = {};
      if (filters.status) {
        whereClause.status = filters.status;
      }
      if (filters.eventId) {
        whereClause.eventId = filters.eventId;
      }

      const [simulations, total] = await Promise.all([
        this.prisma.simulation.findMany({
          where: whereClause,
          skip: offset,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            event: {
              select: {
                eventId: true,
                name: true,
                venue: true,
                eventDate: true,
                eventType: true
              }
            }
          }
        }),
        this.prisma.simulation.count({ where: whereClause })
      ]);

      logger.info('Simulations retrieved successfully', { count: simulations.length, total });
      return { simulations, total };
    } catch (error) {
      logger.error('Error retrieving simulations', { error: error.message });
      throw new Error(`Failed to retrieve simulations: ${error.message}`);
    }
  }

  /**
   * Deletes a simulation
   * @param {string} simulationId - Simulation ID
   * @returns {Promise<void>}
   */
  async deleteSimulation(simulationId) {
    try {
      logger.info('Deleting simulation from database', { simulationId });

      await this.prisma.simulation.delete({
        where: { simulationId }
      });

      logger.info('Simulation deleted successfully', { simulationId });
    } catch (error) {
      logger.error('Error deleting simulation', { simulationId, error: error.message });
      throw new Error(`Failed to delete simulation: ${error.message}`);
    }
  }

  /**
   * Creates or updates simulation progress
   * @param {string} simulationId - Simulation ID
   * @param {Object} progressData - Progress data
   * @returns {Promise<Object>} - Updated simulation
   */
  async updateSimulationProgress(simulationId, progressData) {
    try {
      logger.info('Updating simulation progress', { simulationId, progress: progressData.percentage });

      const simulation = await this.prisma.simulation.update({
        where: { simulationId },
        data: {
          progress: progressData,
          updatedAt: new Date()
        }
      });

      logger.info('Simulation progress updated successfully', { simulationId });
      return simulation;
    } catch (error) {
      logger.error('Error updating simulation progress', { simulationId, error: error.message });
      throw new Error(`Failed to update simulation progress: ${error.message}`);
    }
  }

  /**
   * Retrieves simulation statistics
   * @returns {Promise<Object>} - Statistics object
   */
  async getSimulationStatistics() {
    try {
      logger.info('Retrieving simulation statistics');

      const [totalEvents, totalSimulations, statusCounts] = await Promise.all([
        this.prisma.event.count(),
        this.prisma.simulation.count(),
        this.prisma.simulation.groupBy({
          by: ['status'],
          _count: {
            status: true
          }
        })
      ]);

      const statistics = {
        totalEvents,
        totalSimulations,
        statusDistribution: statusCounts.reduce((acc, item) => {
          acc[item.status] = item._count.status;
          return acc;
        }, {})
      };

      logger.info('Simulation statistics retrieved successfully', statistics);
      return statistics;
    } catch (error) {
      logger.error('Error retrieving simulation statistics', { error: error.message });
      throw new Error(`Failed to retrieve simulation statistics: ${error.message}`);
    }
  }

  /**
   * Closes the database connection
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      await this.prisma.$disconnect();
      logger.info('Database connection closed');
    } catch (error) {
      logger.error('Error closing database connection', { error: error.message });
    }
  }
}

module.exports = new RDSService();

