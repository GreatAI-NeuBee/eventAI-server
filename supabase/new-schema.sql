-- Event AI Database Schema for Supabase (Updated to match provided design)
-- Execute this in your Supabase SQL editor

-- Create custom types for enums
CREATE TYPE user_status AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING');

-- Create users table (simplified)
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    user_id VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(255) UNIQUE NOT NULL,
    status user_status DEFAULT 'ACTIVE',
    phone VARCHAR(20),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT valid_email CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    CONSTRAINT valid_phone CHECK (phone IS NULL OR phone ~* '^\+?[1-9]\d{1,14}$')
);

-- Create events table (main event information)
CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    event_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    date_of_event_start TIMESTAMPTZ NOT NULL,
    date_of_event_end TIMESTAMPTZ NOT NULL,
    venue_layout JSONB, -- Store venue layout configuration
    user_email VARCHAR(255) NOT NULL, -- Email of user who created the event
    forecast_result JSONB, -- Store forecasted crowd predictions
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT check_event_dates CHECK (date_of_event_end > date_of_event_start),
    
    -- Foreign key constraint to users table
    CONSTRAINT fk_events_user_email
        FOREIGN KEY (user_email) 
        REFERENCES users(email) 
        ON DELETE CASCADE
);

-- Create gates table
CREATE TABLE IF NOT EXISTS gates (
    id BIGSERIAL PRIMARY KEY,
    gate_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create zones table
CREATE TABLE IF NOT EXISTS zones (
    id BIGSERIAL PRIMARY KEY,
    zone_id VARCHAR(255) UNIQUE NOT NULL,
    real_capacity INTEGER NOT NULL CHECK (real_capacity > 0),
    expected_capacity INTEGER NOT NULL CHECK (expected_capacity > 0),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create event_schedule table
CREATE TABLE IF NOT EXISTS event_schedule (
    id BIGSERIAL PRIMARY KEY,
    schedule_id VARCHAR(255) UNIQUE NOT NULL,
    event_id VARCHAR(255) NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    activity VARCHAR(255) NOT NULL,
    expected_attendance INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT fk_event_schedule_event
        FOREIGN KEY (event_id) 
        REFERENCES events(event_id) 
        ON DELETE CASCADE
);

-- Create ticketing table
CREATE TABLE IF NOT EXISTS ticketing (
    id BIGSERIAL PRIMARY KEY,
    ticket_id VARCHAR(255) UNIQUE NOT NULL,
    user_id VARCHAR(255),
    event_id VARCHAR(255) NOT NULL,
    gate_id VARCHAR(255),
    zone_id VARCHAR(255),
    check_in_time TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT fk_ticketing_user
        FOREIGN KEY (user_id) 
        REFERENCES users(user_id) 
        ON DELETE SET NULL,
    CONSTRAINT fk_ticketing_event
        FOREIGN KEY (event_id) 
        REFERENCES events(event_id) 
        ON DELETE CASCADE,
    CONSTRAINT fk_ticketing_gate
        FOREIGN KEY (gate_id) 
        REFERENCES gates(gate_id) 
        ON DELETE SET NULL,
    CONSTRAINT fk_ticketing_zone
        FOREIGN KEY (zone_id) 
        REFERENCES zones(zone_id) 
        ON DELETE SET NULL
);

-- Create incidents table
CREATE TABLE IF NOT EXISTS incidents (
    id BIGSERIAL PRIMARY KEY,
    incident_id VARCHAR(255) UNIQUE NOT NULL,
    event_id VARCHAR(255) NOT NULL,
    incident_time TIMESTAMPTZ NOT NULL,
    duration INTEGER, -- Duration in minutes
    resolve_time TIMESTAMPTZ,
    zone_id VARCHAR(255),
    gate_id VARCHAR(255),
    description TEXT,
    severity VARCHAR(50) CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT fk_incidents_event
        FOREIGN KEY (event_id) 
        REFERENCES events(event_id) 
        ON DELETE CASCADE,
    CONSTRAINT fk_incidents_zone
        FOREIGN KEY (zone_id) 
        REFERENCES zones(zone_id) 
        ON DELETE SET NULL,
    CONSTRAINT fk_incidents_gate
        FOREIGN KEY (gate_id) 
        REFERENCES gates(gate_id) 
        ON DELETE SET NULL
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id);
CREATE INDEX IF NOT EXISTS idx_events_date_of_event_start ON events(date_of_event_start);
CREATE INDEX IF NOT EXISTS idx_events_date_of_event_end ON events(date_of_event_end);
CREATE INDEX IF NOT EXISTS idx_events_user_email ON events(user_email);
CREATE INDEX IF NOT EXISTS idx_events_venue_layout ON events USING GIN (venue_layout);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gates_gate_id ON gates(gate_id);
CREATE INDEX IF NOT EXISTS idx_zones_zone_id ON zones(zone_id);

CREATE INDEX IF NOT EXISTS idx_event_schedule_event_id ON event_schedule(event_id);
CREATE INDEX IF NOT EXISTS idx_event_schedule_start_time ON event_schedule(start_time);

CREATE INDEX IF NOT EXISTS idx_ticketing_user_id ON ticketing(user_id);
CREATE INDEX IF NOT EXISTS idx_ticketing_event_id ON ticketing(event_id);
CREATE INDEX IF NOT EXISTS idx_ticketing_gate_id ON ticketing(gate_id);
CREATE INDEX IF NOT EXISTS idx_ticketing_zone_id ON ticketing(zone_id);
CREATE INDEX IF NOT EXISTS idx_ticketing_check_in_time ON ticketing(check_in_time);

CREATE INDEX IF NOT EXISTS idx_incidents_event_id ON incidents(event_id);
CREATE INDEX IF NOT EXISTS idx_incidents_incident_time ON incidents(incident_time);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
CREATE INDEX IF NOT EXISTS idx_incidents_zone_id ON incidents(zone_id);
CREATE INDEX IF NOT EXISTS idx_incidents_gate_id ON incidents(gate_id);

-- Create function to update updated_at timestamps
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

CREATE TRIGGER update_gates_updated_at 
    BEFORE UPDATE ON gates 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_zones_updated_at 
    BEFORE UPDATE ON zones 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_event_schedule_updated_at 
    BEFORE UPDATE ON event_schedule 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ticketing_updated_at 
    BEFORE UPDATE ON ticketing 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_incidents_updated_at 
    BEFORE UPDATE ON incidents 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security (RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticketing ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;

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

CREATE POLICY "Allow all operations for service role on gates" 
    ON gates FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);

CREATE POLICY "Allow all operations for service role on zones" 
    ON zones FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);

CREATE POLICY "Allow all operations for service role on event_schedule" 
    ON event_schedule FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);

CREATE POLICY "Allow all operations for service role on ticketing" 
    ON ticketing FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);

CREATE POLICY "Allow all operations for service role on incidents" 
    ON incidents FOR ALL 
    TO service_role 
    USING (true) 
    WITH CHECK (true);

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

-- Create event statistics view
CREATE OR REPLACE VIEW event_statistics AS
SELECT 
    COUNT(*) as total_events,
    COUNT(CASE WHEN date_of_event_start > NOW() THEN 1 END) as upcoming_events,
    COUNT(CASE WHEN date_of_event_end <= NOW() THEN 1 END) as past_events,
    COUNT(CASE WHEN date_of_event_start <= NOW() AND date_of_event_end > NOW() THEN 1 END) as ongoing_events,
    COUNT(CASE WHEN forecast_result IS NOT NULL THEN 1 END) as events_with_forecast
FROM events;

-- Grant necessary permissions
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT SELECT ON ALL VIEWS IN SCHEMA public TO anon, authenticated, service_role;

-- Grant sequence permissions
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;

-- Comments for documentation
COMMENT ON TABLE users IS 'Stores user accounts and profiles for the Event AI system';
COMMENT ON TABLE events IS 'Stores main event information';
COMMENT ON TABLE gates IS 'Stores gate information for venues';
COMMENT ON TABLE zones IS 'Stores zone information with capacity details';
COMMENT ON TABLE event_schedule IS 'Stores scheduled activities for events';
COMMENT ON TABLE ticketing IS 'Stores ticket information and check-ins';
COMMENT ON TABLE incidents IS 'Stores incident reports during events';
COMMENT ON COLUMN events.forecast_result IS 'JSON field storing crowd forecasting predictions from AI model';
COMMENT ON VIEW user_statistics IS 'Provides statistical overview of users';
COMMENT ON VIEW event_statistics IS 'Provides statistical overview of events';
