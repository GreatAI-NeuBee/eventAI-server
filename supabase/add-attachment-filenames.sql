-- Add attachment_filenames column to events table
-- Execute this in your Supabase SQL editor

-- Add attachment_filenames column to store original file names
ALTER TABLE events 
ADD COLUMN IF NOT EXISTS attachment_filenames JSONB DEFAULT '[]';

-- Create index for attachment_filenames for better performance
CREATE INDEX IF NOT EXISTS idx_events_attachment_filenames ON events USING GIN (attachment_filenames);

-- Add comment for documentation
COMMENT ON COLUMN events.attachment_filenames IS 'JSON array of original attachment filenames corresponding to attachment_urls';

-- Update the event_statistics view to include attachment filename information
CREATE OR REPLACE VIEW event_statistics AS
SELECT 
    COUNT(*) as total_events,
    COUNT(CASE WHEN date_of_event_start > NOW() THEN 1 END) as upcoming_events,
    COUNT(CASE WHEN date_of_event_end <= NOW() THEN 1 END) as past_events,
    COUNT(CASE WHEN date_of_event_start <= NOW() AND date_of_event_end > NOW() THEN 1 END) as ongoing_events,
    COUNT(CASE WHEN forecast_result IS NOT NULL THEN 1 END) as events_with_forecast,
    COUNT(CASE WHEN attachment_urls IS NOT NULL AND jsonb_array_length(attachment_urls) > 0 THEN 1 END) as events_with_attachments
FROM events;

-- Grant necessary permissions for the new column
GRANT SELECT ON TABLE events TO anon, authenticated;
GRANT ALL ON TABLE events TO postgres, service_role;
