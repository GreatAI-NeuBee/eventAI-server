-- Add popularity and popularity_extent columns to events table
-- Execute this in your Supabase SQL editor

-- Add popularity column to store event popularity information
ALTER TABLE events 
ADD COLUMN IF NOT EXISTS popularity JSONB DEFAULT NULL;

-- Add popularity_extent column to store AI-analyzed popularity insights
ALTER TABLE events 
ADD COLUMN IF NOT EXISTS popularity_extent JSONB DEFAULT NULL;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_events_popularity ON events USING GIN (popularity);
CREATE INDEX IF NOT EXISTS idx_events_popularity_extent ON events USING GIN (popularity_extent);

-- Add comments for documentation
COMMENT ON COLUMN events.popularity IS 'JSON object containing event popularity data: {type: "concert|event", feat: "artist names", location: "country"}';
COMMENT ON COLUMN events.popularity_extent IS 'JSON object containing AI-analyzed popularity insights and suggestions from AWS Bedrock Nova Lite';

-- Grant necessary permissions for the new columns
GRANT SELECT ON TABLE events TO anon, authenticated;
GRANT ALL ON TABLE events TO postgres, service_role;

