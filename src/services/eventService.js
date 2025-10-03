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
  defaultMeta: { service: 'event-service' },
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
  logger.error('Missing Supabase configuration. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
}

// Use service role key for server-side operations (bypasses RLS)
const supabaseKey = supabaseServiceKey || supabaseAnonKey;
const supabase = createClient(supabaseUrl, supabaseKey);

class EventService {
  constructor() {
    this.client = supabase;
  }

  /**
   * Creates a new event
   * @param {Object} eventData - Event data to create
   * @returns {Promise<Object>} - Created event
   */
  async createEvent(eventData) {
    try {
      logger.info('Creating event', { eventId: eventData.eventId, name: eventData.name });

      // Prepare event data
      const eventRecord = {
        event_id: eventData.eventId,
        name: eventData.name,
        description: eventData.description || null,
        venue: eventData.venue || null,
        date_of_event_start: eventData.dateOfEventStart,
        date_of_event_end: eventData.dateOfEventEnd,
        status: eventData.status || 'CREATED',
        venue_layout: eventData.venueLayout || null,
        user_email: eventData.userEmail,
        forecast_result: null, // Will be populated by forecast service
        attachment_urls: eventData.attachmentUrls || [],
        attachment_context: eventData.attachmentContext || null
      };

      const { data: event, error } = await this.client
        .from('events')
        .insert(eventRecord)
        .select(`
          id, event_id, name, description, venue, date_of_event_start, date_of_event_end, status, venue_layout, user_email, forecast_result, attachment_urls, attachment_filenames, attachment_context, created_at, updated_at
        `)
        .single();

      if (error) throw error;

      logger.info('Event created successfully', { eventId: eventData.eventId });
      return this.convertEventToCamelCase(event);
    } catch (error) {
      logger.error('Error creating event', { eventId: eventData.eventId, error: error.message });
      
      // Handle duplicate key errors
      if (error.code === '23505') {
        throw new Error('Event ID already exists');
      }
      
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
      logger.info('Retrieving event by ID', { eventId });

      const { data: event, error } = await this.client
        .from('events')
        .select(`
          id, event_id, name, description, venue, date_of_event_start, date_of_event_end, status, venue_layout, user_email, forecast_result, attachment_urls, attachment_filenames, attachment_context, created_at, updated_at
        `)
        .eq('event_id', eventId)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = not found
        throw error;
      }

      if (event) {
        logger.info('Event retrieved successfully', { eventId });
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
   * Retrieves events with pagination and filtering
   * @param {number} limit - Number of events to retrieve
   * @param {number} offset - Number of events to skip
   * @param {Object} filters - Filter criteria
   * @returns {Promise<{events: Object[], total: number}>} - Events and total count
   */
  async getEvents(limit = 10, offset = 0, filters = {}) {
    try {
      logger.info('Retrieving events with pagination', { limit, offset, filters });

      // Get total count first (with filters applied)
      let countQuery = this.client.from('events').select('*', { count: 'exact', head: true });
      
      // Apply filters to count query
      if (filters.userEmail) {
        countQuery = countQuery.eq('user_email', filters.userEmail);
      }
      if (filters.upcoming) {
        countQuery = countQuery.gte('date_of_event_start', new Date().toISOString());
      }
      if (filters.past) {
        countQuery = countQuery.lt('date_of_event_end', new Date().toISOString());
      }
      if (filters.ongoing) {
        const now = new Date().toISOString();
        countQuery = countQuery.lte('date_of_event_start', now).gte('date_of_event_end', now);
      }
      if (filters.withForecast) {
        countQuery = countQuery.not('forecast_result', 'is', null);
      }
      if (filters.search) {
        countQuery = countQuery.ilike('name', `%${filters.search}%`);
      }
      if (filters.startDate) {
        countQuery = countQuery.gte('date_of_event_start', filters.startDate);
      }
      if (filters.endDate) {
        countQuery = countQuery.lte('date_of_event_end', filters.endDate);
      }
      if (filters.status) {
        countQuery = countQuery.eq('status', filters.status);
      }
      if (filters.venue) {
        countQuery = countQuery.ilike('venue', `%${filters.venue}%`);
      }
      
      const { count, error: countError } = await countQuery;
      if (countError) throw countError;

      // Get events data
      let dataQuery = this.client.from('events')
        .select(`
          id, event_id, name, description, venue, date_of_event_start, date_of_event_end, status, venue_layout, user_email, forecast_result, attachment_urls, attachment_filenames, attachment_context, created_at, updated_at
        `)
        .order('date_of_event_start', { ascending: true })
        .range(offset, offset + limit - 1);

      // Apply same filters to data query
      if (filters.userEmail) {
        dataQuery = dataQuery.eq('user_email', filters.userEmail);
      }
      if (filters.upcoming) {
        dataQuery = dataQuery.gte('date_of_event_start', new Date().toISOString());
      }
      if (filters.past) {
        dataQuery = dataQuery.lt('date_of_event_end', new Date().toISOString());
      }
      if (filters.ongoing) {
        const now = new Date().toISOString();
        dataQuery = dataQuery.lte('date_of_event_start', now).gte('date_of_event_end', now);
      }
      if (filters.withForecast) {
        dataQuery = dataQuery.not('forecast_result', 'is', null);
      }
      if (filters.search) {
        dataQuery = dataQuery.ilike('name', `%${filters.search}%`);
      }
      if (filters.startDate) {
        dataQuery = dataQuery.gte('date_of_event_start', filters.startDate);
      }
      if (filters.endDate) {
        dataQuery = dataQuery.lte('date_of_event_end', filters.endDate);
      }
      if (filters.status) {
        dataQuery = dataQuery.eq('status', filters.status);
      }
      if (filters.venue) {
        dataQuery = dataQuery.ilike('venue', `%${filters.venue}%`);
      }

      const { data: events, error: eventsError } = await dataQuery;

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
      logger.info('Updating event', { eventId });

      const updateFields = {};
      
      // Map camelCase to snake_case and validate fields
      if (updateData.name) updateFields.name = updateData.name;
      if (updateData.description !== undefined) updateFields.description = updateData.description;
      if (updateData.venue !== undefined) updateFields.venue = updateData.venue;
      if (updateData.dateOfEventStart) updateFields.date_of_event_start = updateData.dateOfEventStart;
      if (updateData.dateOfEventEnd) updateFields.date_of_event_end = updateData.dateOfEventEnd;
      if (updateData.status) updateFields.status = updateData.status;
      if (updateData.venueLayout !== undefined) updateFields.venue_layout = updateData.venueLayout;
      if (updateData.userEmail) updateFields.user_email = updateData.userEmail;
      if (updateData.forecastResult !== undefined) updateFields.forecast_result = updateData.forecastResult;
      if (updateData.attachmentUrls !== undefined) updateFields.attachment_urls = updateData.attachmentUrls;
      if (updateData.attachmentFilenames !== undefined) updateFields.attachment_filenames = updateData.attachmentFilenames;
      if (updateData.attachmentContext !== undefined) updateFields.attachment_context = updateData.attachmentContext;

      const { data: event, error } = await this.client
        .from('events')
        .update(updateFields)
        .eq('event_id', eventId)
        .select(`
          id, event_id, name, description, venue, date_of_event_start, date_of_event_end, status, venue_layout, user_email, forecast_result, attachment_urls, attachment_filenames, attachment_context, created_at, updated_at
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
   * Updates event forecast result
   * @param {string} eventId - Event ID
   * @param {Object} forecastResult - Forecast data from AI model
   * @returns {Promise<Object>} - Updated event
   */
  async updateEventForecast(eventId, forecastResult) {
    try {
      logger.info('Updating event forecast', { eventId });

      const { data: event, error } = await this.client
        .from('events')
        .update({ forecast_result: forecastResult })
        .eq('event_id', eventId)
        .select(`
          id, event_id, name, description, venue, date_of_event_start, date_of_event_end, status, venue_layout, user_email, forecast_result, attachment_urls, attachment_filenames, attachment_context, created_at, updated_at
        `)
        .single();

      if (error) throw error;

      logger.info('Event forecast updated successfully', { eventId });
      return this.convertEventToCamelCase(event);
    } catch (error) {
      logger.error('Error updating event forecast', { eventId, error: error.message });
      throw new Error(`Failed to update event forecast: ${error.message}`);
    }
  }

  /**
   * Deletes an event
   * @param {string} eventId - Event ID
   * @returns {Promise<void>}
   */
  async deleteEvent(eventId) {
    try {
      logger.info('Deleting event', { eventId });

      const { error } = await this.client
        .from('events')
        .delete()
        .eq('event_id', eventId);

      if (error) throw error;

      logger.info('Event deleted successfully', { eventId });
    } catch (error) {
      logger.error('Error deleting event', { eventId, error: error.message });
      throw new Error(`Failed to delete event: ${error.message}`);
    }
  }

  /**
   * Retrieves event statistics
   * @returns {Promise<Object>} - Statistics object
   */
  async getEventStatistics() {
    try {
      logger.info('Retrieving event statistics');

      const { data: stats, error } = await this.client
        .from('event_statistics')
        .select('*')
        .single();

      if (error) throw error;

      // Convert snake_case to camelCase
      const statistics = {
        totalEvents: stats.total_events,
        upcomingEvents: stats.upcoming_events,
        pastEvents: stats.past_events,
        ongoingEvents: stats.ongoing_events,
        eventsWithForecast: stats.events_with_forecast
      };

      logger.info('Event statistics retrieved successfully', statistics);
      return statistics;
    } catch (error) {
      logger.error('Error retrieving event statistics', { error: error.message });
      throw new Error(`Failed to retrieve event statistics: ${error.message}`);
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
      name: event.name,
      description: event.description,
      venue: event.venue,
      dateOfEventStart: event.date_of_event_start,
      dateOfEventEnd: event.date_of_event_end,
      status: event.status,
      venueLayout: event.venue_layout,
      userEmail: event.user_email,
      forecastResult: event.forecast_result,
      attachmentUrls: event.attachment_urls,
      attachmentFilenames: event.attachment_filenames,
      attachmentContext: event.attachment_context,
      createdAt: event.created_at,
      updatedAt: event.updated_at
    };
  }

  /**
   * Retrieves events created by a specific user
   * @param {string} userEmail - User email
   * @param {number} limit - Number of events to retrieve
   * @param {number} offset - Number of events to skip
   * @param {Object} additionalFilters - Additional filter criteria
   * @returns {Promise<{events: Object[], total: number}>} - Events and total count
   */
  async getEventsByUser(userEmail, limit = 10, offset = 0, additionalFilters = {}) {
    try {
      logger.info('Retrieving events by user', { userEmail, limit, offset });

      const filters = {
        userEmail,
        ...additionalFilters
      };

      const result = await this.getEvents(limit, offset, filters);

      logger.info('Events by user retrieved successfully', { 
        userEmail, 
        count: result.events.length, 
        total: result.total 
      });

      return result;
    } catch (error) {
      logger.error('Error retrieving events by user', { userEmail, error: error.message });
      throw new Error(`Failed to retrieve events for user: ${error.message}`);
    }
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

      logger.info('Event service connection test successful');
      return true;
    } catch (error) {
      logger.error('Event service connection test failed', { error: error.message });
      return false;
    }
  }
}

module.exports = new EventService();
