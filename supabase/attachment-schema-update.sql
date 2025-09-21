-- Database schema update to add attachment support for AI chatbot knowledge base
-- Execute this in your Supabase SQL editor

-- Add attachment columns to events table
ALTER TABLE events 
ADD COLUMN IF NOT EXISTS attachment_urls JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS attachment_context TEXT;

-- Create index for attachment_urls for better performance when querying
CREATE INDEX IF NOT EXISTS idx_events_attachment_urls ON events USING GIN (attachment_urls);

-- Add comments for documentation
COMMENT ON COLUMN events.attachment_urls IS 'JSON array of attachment URL strings for AI chatbot knowledge base';
COMMENT ON COLUMN events.attachment_context IS 'Text interpretation/context of attachments for AI chatbot knowledge base';

-- Update the event_statistics view to include attachment information
CREATE OR REPLACE VIEW event_statistics AS
SELECT 
    COUNT(*) as total_events,
    COUNT(CASE WHEN date_of_event_start > NOW() THEN 1 END) as upcoming_events,
    COUNT(CASE WHEN date_of_event_end <= NOW() THEN 1 END) as past_events,
    COUNT(CASE WHEN date_of_event_start <= NOW() AND date_of_event_end > NOW() THEN 1 END) as ongoing_events,
    COUNT(CASE WHEN forecast_result IS NOT NULL THEN 1 END) as events_with_forecast,
    COUNT(CASE WHEN attachment_urls IS NOT NULL AND jsonb_array_length(attachment_urls) > 0 THEN 1 END) as events_with_attachments
FROM events;

-- Grant necessary permissions for the new columns
GRANT SELECT ON TABLE events TO anon, authenticated;
GRANT ALL ON TABLE events TO postgres, service_role;
