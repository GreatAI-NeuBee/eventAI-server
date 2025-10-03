-- Add predict_result column to events table
-- Execute this in your Supabase SQL editor

-- Add predict_result column to store real-time prediction results
ALTER TABLE events 
ADD COLUMN IF NOT EXISTS predict_result JSONB DEFAULT NULL;

-- Create index for predict_result for better performance
CREATE INDEX IF NOT EXISTS idx_events_predict_result ON events USING GIN (predict_result);

-- Add comment for documentation
COMMENT ON COLUMN events.predict_result IS 'JSON object containing real-time prediction results from AI model, updated every 5 minutes during event';

-- Drop and recreate the event_statistics view to include prediction information
DROP VIEW IF EXISTS event_statistics;

CREATE VIEW event_statistics AS
SELECT 
    COUNT(*) as total_events,
    COUNT(CASE WHEN date_of_event_start > NOW() THEN 1 END) as upcoming_events,
    COUNT(CASE WHEN date_of_event_end <= NOW() THEN 1 END) as past_events,
    COUNT(CASE WHEN date_of_event_start <= NOW() AND date_of_event_end > NOW() THEN 1 END) as ongoing_events,
    COUNT(CASE WHEN forecast_result IS NOT NULL THEN 1 END) as events_with_forecast,
    COUNT(CASE WHEN predict_result IS NOT NULL THEN 1 END) as events_with_predictions,
    COUNT(CASE WHEN attachment_urls IS NOT NULL AND jsonb_array_length(attachment_urls) > 0 THEN 1 END) as events_with_attachments
FROM events;

-- Grant necessary permissions for the new column
GRANT SELECT ON TABLE events TO anon, authenticated;
GRANT ALL ON TABLE events TO postgres, service_role;
