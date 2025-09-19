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
  defaultMeta: { service: 'user-service' },
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

class UserService {
  constructor() {
    this.client = supabase;
  }

  /**
   * Creates a new user
   * @param {Object} userData - User data to create
   * @returns {Promise<Object>} - Created user
   */
  async createUser(userData) {
    try {
      logger.info('Creating user', { email: userData.email });

      // Prepare user data - username can come from OAuth provider or default to email
      const userRecord = {
        user_id: userData.userId,
        email: userData.email.toLowerCase(),
        username: userData.username || userData.email.toLowerCase(), // Use provided username (e.g., from Google) or email as fallback
        status: userData.status || 'ACTIVE',
        phone: userData.phone || null
      };

      const { data: user, error } = await this.client
        .from('users')
        .insert(userRecord)
        .select(`
          id, user_id, email, username, status, phone, created_at, updated_at
        `)
        .single();

      if (error) throw error;

      logger.info('User created successfully', { userId: userData.userId, email: userData.email });
      return this.convertUserToCamelCase(user);
    } catch (error) {
      logger.error('Error creating user', { email: userData.email, error: error.message });
      
      // Handle duplicate key errors
      if (error.code === '23505') {
        if (error.message.includes('email')) {
          throw new Error('Email already exists');
        } else if (error.message.includes('username')) {
          throw new Error('Username already exists');
        } else if (error.message.includes('user_id')) {
          throw new Error('User ID already exists');
        }
      }
      
      throw new Error(`Failed to create user: ${error.message}`);
    }
  }

  /**
   * Creates a user from OAuth provider data (Google, etc.)
   * @param {Object} oauthData - OAuth provider data
   * @returns {Promise<Object>} - Created user
   */
  async createUserFromOAuth(oauthData) {
    try {
      logger.info('Creating user from OAuth', { 
        email: oauthData.email, 
        provider: oauthData.provider,
        providerId: oauthData.providerId 
      });

      // Generate unique user ID
      const userId = `usr_${require('uuid').v4()}`;

      // Prepare user data with OAuth information
      const userRecord = {
        user_id: userId,
        email: oauthData.email.toLowerCase(),
        username: this.generateUsernameFromOAuth(oauthData),
        status: oauthData.status || 'ACTIVE',
        phone: oauthData.phone || null
      };

      const { data: user, error } = await this.client
        .from('users')
        .insert(userRecord)
        .select(`
          id, user_id, email, username, status, phone, created_at, updated_at
        `)
        .single();

      if (error) throw error;

      logger.info('OAuth user created successfully', { 
        userId, 
        email: oauthData.email,
        username: userRecord.username,
        provider: oauthData.provider 
      });
      
      return this.convertUserToCamelCase(user);
    } catch (error) {
      logger.error('Error creating OAuth user', { 
        email: oauthData.email, 
        provider: oauthData.provider,
        error: error.message 
      });
      
      // Handle duplicate key errors
      if (error.code === '23505') {
        if (error.message.includes('email')) {
          throw new Error('Email already exists');
        } else if (error.message.includes('username')) {
          throw new Error('Username already exists');
        }
      }
      
      throw new Error(`Failed to create OAuth user: ${error.message}`);
    }
  }

  /**
   * Generates username from OAuth provider data
   * @param {Object} oauthData - OAuth provider data
   * @returns {string} - Generated username
   */
  generateUsernameFromOAuth(oauthData) {
    // Priority order for username generation:
    // 1. Explicit username from provider
    // 2. Display name from provider (cleaned)
    // 3. Name from provider (cleaned)
    // 4. Email as fallback

    if (oauthData.username) {
      return this.sanitizeUsername(oauthData.username);
    }

    if (oauthData.displayName) {
      return this.sanitizeUsername(oauthData.displayName);
    }

    if (oauthData.name) {
      return this.sanitizeUsername(oauthData.name);
    }

    if (oauthData.given_name && oauthData.family_name) {
      return this.sanitizeUsername(`${oauthData.given_name} ${oauthData.family_name}`);
    }

    if (oauthData.given_name) {
      return this.sanitizeUsername(oauthData.given_name);
    }

    // Fallback to email
    return oauthData.email.toLowerCase();
  }

  /**
   * Sanitizes username for database storage
   * @param {string} username - Raw username
   * @returns {string} - Sanitized username
   */
  sanitizeUsername(username) {
    return username
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '_')           // Replace spaces with underscores
      .replace(/[^a-z0-9._-]/g, '')   // Remove special characters except ._-
      .substring(0, 50);              // Limit length
  }

  /**
   * Retrieves a user by ID
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} - User data or null if not found
   */
  async getUserById(userId) {
    try {
      logger.info('Retrieving user by ID', { userId });

      const { data: user, error } = await this.client
        .from('users')
        .select(`
          id, user_id, email, username, status, phone, created_at, updated_at
        `)
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = not found
        throw error;
      }

      if (user) {
        logger.info('User retrieved successfully', { userId });
        return this.convertUserToCamelCase(user);
      } else {
        logger.warn('User not found', { userId });
        return null;
      }
    } catch (error) {
      logger.error('Error retrieving user', { userId, error: error.message });
      throw new Error(`Failed to retrieve user: ${error.message}`);
    }
  }

  /**
   * Retrieves a user by email
   * @param {string} email - User email
   * @returns {Promise<Object|null>} - User data or null if not found
   */
  async getUserByEmail(email) {
    try {
      logger.info('Retrieving user by email', { email });

      const { data: user, error } = await this.client
        .from('users')
        .select(`
          id, user_id, email, username, status, phone, created_at, updated_at
        `)
        .eq('email', email.toLowerCase())
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      if (user) {
        logger.info('User retrieved successfully', { email });
        return this.convertUserToCamelCase(user);
      } else {
        logger.warn('User not found', { email });
        return null;
      }
    } catch (error) {
      logger.error('Error retrieving user by email', { email, error: error.message });
      throw new Error(`Failed to retrieve user: ${error.message}`);
    }
  }

  /**
   * Retrieves a user by username
   * @param {string} username - Username
   * @returns {Promise<Object|null>} - User data or null if not found
   */
  async getUserByUsername(username) {
    try {
      logger.info('Retrieving user by username', { username });

      const { data: user, error } = await this.client
        .from('users')
        .select(`
          id, user_id, email, username, status, phone, created_at, updated_at
        `)
        .eq('username', username.toLowerCase())
        .single();

      if (error && error.code !== 'PGRST116') {
        throw error;
      }

      if (user) {
        logger.info('User retrieved successfully', { username });
        return this.convertUserToCamelCase(user);
      } else {
        logger.warn('User not found', { username });
        return null;
      }
    } catch (error) {
      logger.error('Error retrieving user by username', { username, error: error.message });
      throw new Error(`Failed to retrieve user: ${error.message}`);
    }
  }

  /**
   * Retrieves users with pagination and filtering
   * @param {number} limit - Number of users to retrieve
   * @param {number} offset - Number of users to skip
   * @param {Object} filters - Filter criteria
   * @returns {Promise<{users: Object[], total: number}>} - Users and total count
   */
  async getUsers(limit = 10, offset = 0, filters = {}) {
    try {
      logger.info('Retrieving users with pagination', { limit, offset, filters });

      let query = this.client.from('users');

      // Apply filters
      if (filters.status) {
        query = query.eq('status', filters.status.toUpperCase());
      }
      if (filters.search) {
        // Search across email and username
        query = query.or(`email.ilike.%${filters.search}%,username.ilike.%${filters.search}%`);
      }

      // Get total count with filters
      const { count, error: countError } = await query
        .select('*', { count: 'exact', head: true });

      if (countError) throw countError;

      // Get users data
      let dataQuery = this.client.from('users')
        .select(`
          id, user_id, email, username, status, phone, created_at, updated_at
        `)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      // Apply same filters to data query
      if (filters.status) {
        dataQuery = dataQuery.eq('status', filters.status.toUpperCase());
      }
      if (filters.search) {
        dataQuery = dataQuery.or(`email.ilike.%${filters.search}%,username.ilike.%${filters.search}%`);
      }

      const { data: users, error: usersError } = await dataQuery;

      if (usersError) throw usersError;

      const convertedUsers = users.map(user => this.convertUserToCamelCase(user));

      logger.info('Users retrieved successfully', { count: users.length, total: count });
      return { users: convertedUsers, total: count };
    } catch (error) {
      logger.error('Error retrieving users', { error: error.message });
      throw new Error(`Failed to retrieve users: ${error.message}`);
    }
  }

  /**
   * Updates a user
   * @param {string} userId - User ID
   * @param {Object} updateData - Data to update
   * @returns {Promise<Object>} - Updated user
   */
  async updateUser(userId, updateData) {
    try {
      logger.info('Updating user', { userId });

      const updateFields = {};
      
      // Map camelCase to snake_case and validate fields
      if (updateData.email) updateFields.email = updateData.email.toLowerCase();
      if (updateData.username) updateFields.username = updateData.username.toLowerCase();
      if (updateData.status) updateFields.status = updateData.status.toUpperCase();
      if (updateData.phone !== undefined) updateFields.phone = updateData.phone;

      const { data: user, error } = await this.client
        .from('users')
        .update(updateFields)
        .eq('user_id', userId)
        .select(`
          id, user_id, email, username, status, phone, created_at, updated_at
        `)
        .single();

      if (error) throw error;

      logger.info('User updated successfully', { userId });
      return this.convertUserToCamelCase(user);
    } catch (error) {
      logger.error('Error updating user', { userId, error: error.message });
      
      // Handle duplicate key errors
      if (error.code === '23505') {
        if (error.message.includes('email')) {
          throw new Error('Email already exists');
        } else if (error.message.includes('username')) {
          throw new Error('Username already exists');
        }
      }
      
      throw new Error(`Failed to update user: ${error.message}`);
    }
  }

  /**
   * Deletes a user
   * @param {string} userId - User ID
   * @returns {Promise<void>}
   */
  async deleteUser(userId) {
    try {
      logger.info('Deleting user', { userId });

      const { error } = await this.client
        .from('users')
        .delete()
        .eq('user_id', userId);

      if (error) throw error;

      logger.info('User deleted successfully', { userId });
    } catch (error) {
      logger.error('Error deleting user', { userId, error: error.message });
      throw new Error(`Failed to delete user: ${error.message}`);
    }
  }


  /**
   * Retrieves user statistics
   * @returns {Promise<Object>} - Statistics object
   */
  async getUserStatistics() {
    try {
      logger.info('Retrieving user statistics');

      const { data: stats, error } = await this.client
        .from('user_statistics')
        .select('*')
        .single();

      if (error) throw error;

      // Convert snake_case to camelCase
      const statistics = {
        totalUsers: stats.total_users,
        activeUsers: stats.active_users,
        inactiveUsers: stats.inactive_users,
        suspendedUsers: stats.suspended_users,
        pendingUsers: stats.pending_users,
        usersWithPhone: stats.users_with_phone
      };

      logger.info('User statistics retrieved successfully', statistics);
      return statistics;
    } catch (error) {
      logger.error('Error retrieving user statistics', { error: error.message });
      throw new Error(`Failed to retrieve user statistics: ${error.message}`);
    }
  }

  /**
   * Convert snake_case to camelCase for user objects
   * @param {Object} user - User from Supabase
   * @returns {Object} - Converted user
   */
  convertUserToCamelCase(user) {
    return {
      id: user.id,
      userId: user.user_id,
      email: user.email,
      username: user.username,
      status: user.status,
      phone: user.phone,
      createdAt: user.created_at,
      updatedAt: user.updated_at
    };
  }

  /**
   * Test Supabase connection
   * @returns {Promise<boolean>} - Connection status
   */
  async testConnection() {
    try {
      const { data, error } = await this.client
        .from('users')
        .select('count')
        .limit(1);

      if (error) throw error;

      logger.info('User service connection test successful');
      return true;
    } catch (error) {
      logger.error('User service connection test failed', { error: error.message });
      return false;
    }
  }
}

module.exports = new UserService();
