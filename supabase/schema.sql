-- Event AI Database Schema for Supabase
-- Execute this in your Supabase SQL editor

-- Create custom types for enums
CREATE TYPE event_type AS ENUM ('CONCERT', 'CONFERENCE', 'SPORTS', 'FESTIVAL', 'OTHER');
CREATE TYPE event_status AS ENUM ('CREATED', 'ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE simulation_status AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE user_status AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING');

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(255) UNIQUE NOT NULL, -- Will be same as email initially
    status user_status DEFAULT 'ACTIVE',
    phone VARCHAR(20),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT valid_email CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    CONSTRAINT valid_phone CHECK (phone IS NULL OR phone ~* '^\+?[1-9]\d{1,14}$')
);

-- Create events table
CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    event_id VARCHAR(255) UNIQUE NOT NULL,
    simulation_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    venue VARCHAR(255) NOT NULL,
    expected_attendees INTEGER NOT NULL CHECK (expected_attendees > 0),
    event_date TIMESTAMPTZ NOT NULL,
    event_type event_type NOT NULL,
    s3_keys JSONB DEFAULT '{}',
    status event_status DEFAULT 'CREATED',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create simulations table
CREATE TABLE IF NOT EXISTS simulations (
    id BIGSERIAL PRIMARY KEY,
    simulation_id VARCHAR(255) UNIQUE NOT NULL,
    event_id VARCHAR(255) NOT NULL,
    status simulation_status DEFAULT 'PENDING',
    parameters JSONB,
    progress JSONB,
    results JSONB,
    error TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Foreign key constraint
    CONSTRAINT fk_simulation_event 
        FOREIGN KEY (event_id) 
        REFERENCES events(event_id) 
        ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id);
CREATE INDEX IF NOT EXISTS idx_events_simulation_id ON events(simulation_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_event_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

CREATE INDEX IF NOT EXISTS idx_simulations_simulation_id ON simulations(simulation_id);
CREATE INDEX IF NOT EXISTS idx_simulations_event_id ON simulations(event_id);
CREATE INDEX IF NOT EXISTS idx_simulations_status ON simulations(status);
CREATE INDEX IF NOT EXISTS idx_simulations_created_at ON simulations(created_at DESC);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers to automatically update updated_at
CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON users 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_events_updated_at 
    BEFORE UPDATE ON events 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_simulations_updated_at 
    BEFORE UPDATE ON simulations 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulations ENABLE ROW LEVEL SECURITY;

-- Create policies for authenticated users
-- Allow all operations for authenticated users (you can customize this based on your needs)
CREATE POLICY "Allow all operations for authenticated users on users" 
    ON users FOR ALL 
    TO authenticated 
    USING (true) 
    WITH CHECK (true);

CREATE POLICY "Allow all operations for authenticated users on events" 
    ON events FOR ALL 
    TO authenticated 
    USING (true) 
    WITH CHECK (true);

CREATE POLICY "Allow all operations for authenticated users on simulations" 
    ON simulations FOR ALL 
    TO authenticated 
    USING (true) 
    WITH CHECK (true);

-- Create policies for service role (for server-side operations)
CREATE POLICY "Allow all operations for service role on users" 
    ON users FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);

CREATE POLICY "Allow all operations for service role on events" 
    ON events FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);

CREATE POLICY "Allow all operations for service role on simulations" 
    ON simulations FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);

-- Create a view for event statistics
CREATE OR REPLACE VIEW event_statistics AS
SELECT 
    COUNT(*) as total_events,
    COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) as active_events,
    COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_events,
    COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_events,
    AVG(expected_attendees) as avg_expected_attendees,
    MAX(expected_attendees) as max_expected_attendees
FROM events;

-- Create a view for simulation statistics
CREATE OR REPLACE VIEW simulation_statistics AS
SELECT 
    s.status,
    COUNT(*) as count,
    AVG(EXTRACT(EPOCH FROM (s.completed_at - s.started_at))/60) as avg_duration_minutes
FROM simulations s
WHERE s.status IN ('COMPLETED', 'FAILED')
GROUP BY s.status;

-- Insert sample data for testing (optional)
-- INSERT INTO events (event_id, simulation_id, name, venue, expected_attendees, event_date, event_type) 
-- VALUES (
--     'evt_sample_001',
--     'sim_sample_001', 
--     'Sample Music Festival',
--     'Central Park',
--     5000,
--     '2024-07-15 18:00:00+00',
--     'FESTIVAL'
-- );

-- Create user statistics view
CREATE OR REPLACE VIEW user_statistics AS
SELECT 
    COUNT(*) as total_users,
    COUNT(CASE WHEN status = 'ACTIVE' THEN 1 END) as active_users,
    COUNT(CASE WHEN status = 'INACTIVE' THEN 1 END) as inactive_users,
    COUNT(CASE WHEN status = 'SUSPENDED' THEN 1 END) as suspended_users,
    COUNT(CASE WHEN status = 'PENDING' THEN 1 END) as pending_users,
    COUNT(CASE WHEN phone IS NOT NULL THEN 1 END) as users_with_phone
FROM users;

-- Grant necessary permissions
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE users TO postgres, service_role;
GRANT ALL ON TABLE events TO postgres, service_role;
GRANT ALL ON TABLE simulations TO postgres, service_role;
GRANT SELECT ON TABLE users TO anon, authenticated;
GRANT SELECT ON TABLE events TO anon, authenticated;
GRANT SELECT ON TABLE simulations TO anon, authenticated;
GRANT SELECT ON TABLE user_statistics TO anon, authenticated, service_role;
GRANT SELECT ON TABLE event_statistics TO anon, authenticated, service_role;
GRANT SELECT ON TABLE simulation_statistics TO anon, authenticated, service_role;

-- Grant sequence permissions
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;

COMMENT ON TABLE users IS 'Stores user accounts and profiles for the Event AI system';
COMMENT ON TABLE events IS 'Stores event information for the Event AI system';
COMMENT ON TABLE simulations IS 'Stores simulation data and results for events';
COMMENT ON VIEW user_statistics IS 'Provides statistical overview of users';
COMMENT ON VIEW event_statistics IS 'Provides statistical overview of events';
COMMENT ON VIEW simulation_statistics IS 'Provides statistical overview of simulations';
