-- Quick fix for the view dependency issue
-- Run this in your Supabase SQL editor to resolve the date_of_event column dependency

-- Step 1: Drop the dependent view first
DROP VIEW IF EXISTS event_statistics CASCADE;

-- Step 2: Add new date columns if they don't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'events' AND column_name = 'date_of_event_start'
  ) THEN
    ALTER TABLE events ADD COLUMN date_of_event_start TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'events' AND column_name = 'date_of_event_end'
  ) THEN
    ALTER TABLE events ADD COLUMN date_of_event_end TIMESTAMPTZ;
  END IF;
END $$;

-- Step 3: Migrate data from old column to new columns
UPDATE events 
SET 
  date_of_event_start = date_of_event,
  date_of_event_end = date_of_event + INTERVAL '3 hours'
WHERE date_of_event IS NOT NULL 
  AND (date_of_event_start IS NULL OR date_of_event_end IS NULL);

-- Step 4: Make new columns NOT NULL after data migration
ALTER TABLE events ALTER COLUMN date_of_event_start SET NOT NULL;
ALTER TABLE events ALTER COLUMN date_of_event_end SET NOT NULL;

-- Step 5: Add date range constraint
ALTER TABLE events ADD CONSTRAINT check_event_dates 
  CHECK (date_of_event_end > date_of_event_start);

-- Step 6: Drop the old column (now safe)
ALTER TABLE events DROP COLUMN date_of_event;

-- Step 7: Remove expected_capacity if it exists
ALTER TABLE events DROP COLUMN IF EXISTS expected_capacity;

-- Step 8: Add other required columns if they don't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'events' AND column_name = 'venue_layout'
  ) THEN
    ALTER TABLE events ADD COLUMN venue_layout JSONB;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'events' AND column_name = 'user_email'
  ) THEN
    ALTER TABLE events ADD COLUMN user_email VARCHAR(255);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'events' AND column_name = 'forecast_result'
  ) THEN
    ALTER TABLE events ADD COLUMN forecast_result JSONB;
  END IF;
END $$;

-- Step 9: Create new indexes
DROP INDEX IF EXISTS idx_events_date_of_event;
DROP INDEX IF EXISTS idx_events_expected_capacity;

CREATE INDEX IF NOT EXISTS idx_events_date_of_event_start ON events(date_of_event_start);
CREATE INDEX IF NOT EXISTS idx_events_date_of_event_end ON events(date_of_event_end);
CREATE INDEX IF NOT EXISTS idx_events_user_email ON events(user_email);
CREATE INDEX IF NOT EXISTS idx_events_venue_layout ON events USING GIN (venue_layout);
CREATE INDEX IF NOT EXISTS idx_events_forecast_result ON events USING GIN (forecast_result);

-- Step 10: Recreate the event_statistics view with new schema
CREATE OR REPLACE VIEW event_statistics AS
SELECT 
    COUNT(*) as total_events,
    COUNT(CASE WHEN date_of_event_start > NOW() THEN 1 END) as upcoming_events,
    COUNT(CASE WHEN date_of_event_end <= NOW() THEN 1 END) as past_events,
    COUNT(CASE WHEN date_of_event_start <= NOW() AND date_of_event_end > NOW() THEN 1 END) as ongoing_events,
    COUNT(CASE WHEN forecast_result IS NOT NULL THEN 1 END) as events_with_forecast
FROM events;

-- Step 11: Grant permissions on the new view
GRANT SELECT ON event_statistics TO anon, authenticated, service_role;

-- Step 12: Add foreign key constraint if users table exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'users'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_events_user_email' AND table_name = 'events'
  ) THEN
    ALTER TABLE events ADD CONSTRAINT fk_events_user_email
      FOREIGN KEY (user_email) 
      REFERENCES users(email) 
      ON DELETE CASCADE;
  END IF;
END $$;

-- Verify the final structure
SELECT 
  column_name, 
  data_type, 
  is_nullable, 
  column_default
FROM information_schema.columns 
WHERE table_name = 'events' 
ORDER BY ordinal_position;

-- Show the updated view structure
SELECT * FROM event_statistics;
