const { createClient } = require('@supabase/supabase-js');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'supabase-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || (!supabaseServiceKey && !supabaseAnonKey)) {
  logger.error('Missing Supabase configuration. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)');
}

// Use service role key for server-side operations (bypasses RLS)
const supabaseKey = supabaseServiceKey || supabaseAnonKey;
const supabase = createClient(supabaseUrl, supabaseKey);

class SupabaseService {
  constructor() {
    this.client = supabase;
  }

  /**
   * Creates a new event record
   * @param {Object} eventData - Event data to create
   * @returns {Promise<Object>} - Created event
   */
  async createEvent(eventData) {
    try {
      logger.info('Creating event in Supabase', { eventId: eventData.eventId });

      // Create event and simulation in a transaction
      const { data: event, error: eventError } = await this.client
        .from('events')
        .insert({
          event_id: eventData.eventId,
          simulation_id: eventData.simulationId,
          name: eventData.name,
          description: eventData.description,
          venue: eventData.venue,
          expected_attendees: eventData.expectedAttendees,
          event_date: eventData.eventDate.toISOString(),
          event_type: eventData.eventType,
          s3_keys: eventData.s3Keys || {},
          status: eventData.status,
          created_at: eventData.createdAt.toISOString(),
          updated_at: eventData.updatedAt.toISOString()
        })
        .select()
        .single();

      if (eventError) throw eventError;

      // Create associated simulation record
      const { data: simulation, error: simulationError } = await this.client
        .from('simulations')
        .insert({
          simulation_id: eventData.simulationId,
          event_id: eventData.eventId,
          status: 'PENDING',
          created_at: eventData.createdAt.toISOString(),
          updated_at: eventData.updatedAt.toISOString()
        })
        .select()
        .single();

      if (simulationError) throw simulationError;

      logger.info('Event created successfully', { eventId: eventData.eventId });
      return { ...event, simulation };
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
      logger.info('Retrieving event from Supabase', { eventId });

      const { data: event, error } = await this.client
        .from('events')
        .select(`
          *,
          simulation:simulations(*)
        `)
        .eq('event_id', eventId)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = not found
        throw error;
      }

      if (event) {
        logger.info('Event retrieved successfully', { eventId });
        // Convert snake_case to camelCase for consistency
        return this.convertEventToCamelCase(event);
      } else {
        logger.warn('Event not found', { eventId });
        return null;
      }
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

      // Get total count
      const { count, error: countError } = await this.client
        .from('events')
        .select('*', { count: 'exact', head: true });

      if (countError) throw countError;

      // Get events with simulation data
      const { data: events, error: eventsError } = await this.client
        .from('events')
        .select(`
          *,
          simulation:simulations(simulation_id, status, started_at, completed_at)
        `)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (eventsError) throw eventsError;

      const convertedEvents = events.map(event => this.convertEventToCamelCase(event));

      logger.info('Events retrieved successfully', { count: events.length, total: count });
      return { events: convertedEvents, total: count };
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
      logger.info('Updating event in Supabase', { eventId });

      const { data: event, error } = await this.client
        .from('events')
        .update({
          name: updateData.name,
          description: updateData.description,
          venue: updateData.venue,
          expected_attendees: updateData.expectedAttendees,
          event_date: updateData.eventDate?.toISOString(),
          event_type: updateData.eventType,
          s3_keys: updateData.s3Keys,
          updated_at: updateData.updatedAt?.toISOString() || new Date().toISOString()
        })
        .eq('event_id', eventId)
        .select(`
          *,
          simulation:simulations(*)
        `)
        .single();

      if (error) throw error;

      logger.info('Event updated successfully', { eventId });
      return this.convertEventToCamelCase(event);
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
      logger.info('Deleting event from Supabase', { eventId });

      // Delete associated simulation first (due to foreign key constraints)
      const { error: simulationError } = await this.client
        .from('simulations')
        .delete()
        .eq('event_id', eventId);

      if (simulationError) throw simulationError;

      // Delete the event
      const { error: eventError } = await this.client
        .from('events')
        .delete()
        .eq('event_id', eventId);

      if (eventError) throw eventError;

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
      logger.info('Retrieving simulation from Supabase', { simulationId });

      const { data: simulation, error } = await this.client
        .from('simulations')
        .select(`
          *,
          event:events(event_id, name, venue, event_date, event_type)
        `)
        .eq('simulation_id', simulationId)
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      if (simulation) {
        logger.info('Simulation retrieved successfully', { simulationId });
        return this.convertSimulationToCamelCase(simulation);
      } else {
        logger.warn('Simulation not found', { simulationId });
        return null;
      }
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
        updated_at: new Date().toISOString(),
        ...metadata
      };

      // Convert camelCase to snake_case for specific fields
      if (metadata.startedAt) updateData.started_at = metadata.startedAt.toISOString();
      if (metadata.completedAt) updateData.completed_at = metadata.completedAt.toISOString();
      if (metadata.failedAt) updateData.failed_at = metadata.failedAt.toISOString();
      if (metadata.cancelledAt) updateData.cancelled_at = metadata.cancelledAt.toISOString();

      const { data: simulation, error } = await this.client
        .from('simulations')
        .update(updateData)
        .eq('simulation_id', simulationId)
        .select()
        .single();

      if (error) throw error;

      logger.info('Simulation status updated successfully', { simulationId, status });
      return this.convertSimulationToCamelCase(simulation);
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

      let query = this.client.from('simulations');

      // Apply filters
      if (filters.status) {
        query = query.eq('status', filters.status);
      }
      if (filters.eventId) {
        query = query.eq('event_id', filters.eventId);
      }

      // Get total count with filters
      const { count, error: countError } = await query
        .select('*', { count: 'exact', head: true });

      if (countError) throw countError;

      // Get simulations with event data
      let dataQuery = this.client.from('simulations')
        .select(`
          *,
          event:events(event_id, name, venue, event_date, event_type)
        `)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      // Apply same filters to data query
      if (filters.status) {
        dataQuery = dataQuery.eq('status', filters.status);
      }
      if (filters.eventId) {
        dataQuery = dataQuery.eq('event_id', filters.eventId);
      }

      const { data: simulations, error: simulationsError } = await dataQuery;

      if (simulationsError) throw simulationsError;

      const convertedSimulations = simulations.map(sim => this.convertSimulationToCamelCase(sim));

      logger.info('Simulations retrieved successfully', { count: simulations.length, total: count });
      return { simulations: convertedSimulations, total: count };
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
      logger.info('Deleting simulation from Supabase', { simulationId });

      const { error } = await this.client
        .from('simulations')
        .delete()
        .eq('simulation_id', simulationId);

      if (error) throw error;

      logger.info('Simulation deleted successfully', { simulationId });
    } catch (error) {
      logger.error('Error deleting simulation', { simulationId, error: error.message });
      throw new Error(`Failed to delete simulation: ${error.message}`);
    }
  }

  /**
   * Updates simulation progress
   * @param {string} simulationId - Simulation ID
   * @param {Object} progressData - Progress data
   * @returns {Promise<Object>} - Updated simulation
   */
  async updateSimulationProgress(simulationId, progressData) {
    try {
      logger.info('Updating simulation progress', { simulationId, progress: progressData.percentage });

      const { data: simulation, error } = await this.client
        .from('simulations')
        .update({
          progress: progressData,
          updated_at: new Date().toISOString()
        })
        .eq('simulation_id', simulationId)
        .select()
        .single();

      if (error) throw error;

      logger.info('Simulation progress updated successfully', { simulationId });
      return this.convertSimulationToCamelCase(simulation);
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

      // Get total events count
      const { count: totalEvents, error: eventsError } = await this.client
        .from('events')
        .select('*', { count: 'exact', head: true });

      if (eventsError) throw eventsError;

      // Get total simulations count
      const { count: totalSimulations, error: simulationsError } = await this.client
        .from('simulations')
        .select('*', { count: 'exact', head: true });

      if (simulationsError) throw simulationsError;

      // Get status distribution
      const { data: statusData, error: statusError } = await this.client
        .from('simulations')
        .select('status')
        .order('status');

      if (statusError) throw statusError;

      // Count status distribution
      const statusDistribution = statusData.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {});

      const statistics = {
        totalEvents,
        totalSimulations,
        statusDistribution
      };

      logger.info('Simulation statistics retrieved successfully', statistics);
      return statistics;
    } catch (error) {
      logger.error('Error retrieving simulation statistics', { error: error.message });
      throw new Error(`Failed to retrieve simulation statistics: ${error.message}`);
    }
  }

  /**
   * Convert snake_case to camelCase for event objects
   * @param {Object} event - Event from Supabase
   * @returns {Object} - Converted event
   */
  convertEventToCamelCase(event) {
    return {
      id: event.id,
      eventId: event.event_id,
      simulationId: event.simulation_id,
      name: event.name,
      description: event.description,
      venue: event.venue,
      expectedAttendees: event.expected_attendees,
      eventDate: event.event_date,
      eventType: event.event_type,
      s3Keys: event.s3_keys,
      status: event.status,
      createdAt: event.created_at,
      updatedAt: event.updated_at,
      simulation: event.simulation ? this.convertSimulationToCamelCase(event.simulation) : null
    };
  }

  /**
   * Convert snake_case to camelCase for simulation objects
   * @param {Object} simulation - Simulation from Supabase
   * @returns {Object} - Converted simulation
   */
  convertSimulationToCamelCase(simulation) {
    return {
      id: simulation.id,
      simulationId: simulation.simulation_id,
      eventId: simulation.event_id,
      status: simulation.status,
      parameters: simulation.parameters,
      progress: simulation.progress,
      results: simulation.results,
      error: simulation.error,
      startedAt: simulation.started_at,
      completedAt: simulation.completed_at,
      failedAt: simulation.failed_at,
      cancelledAt: simulation.cancelled_at,
      createdAt: simulation.created_at,
      updatedAt: simulation.updated_at,
      event: simulation.event ? {
        eventId: simulation.event.event_id,
        name: simulation.event.name,
        venue: simulation.event.venue,
        eventDate: simulation.event.event_date,
        eventType: simulation.event.event_type
      } : null
    };
  }

  /**
   * Test Supabase connection
   * @returns {Promise<boolean>} - Connection status
   */
  async testConnection() {
    try {
      const { data, error } = await this.client
        .from('events')
        .select('count')
        .limit(1);

      if (error) throw error;

      logger.info('Supabase connection test successful');
      return true;
    } catch (error) {
      logger.error('Supabase connection test failed', { error: error.message });
      return false;
    }
  }
}

module.exports = new SupabaseService();
