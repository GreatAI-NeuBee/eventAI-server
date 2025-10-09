-- Add nearby_event column to events table
-- This will store Google search results from Serp API

-- Add the nearby_event column as JSONB
ALTER TABLE events 
ADD COLUMN IF NOT EXISTS nearby_event JSONB DEFAULT NULL;

-- Add comment to document the column
COMMENT ON COLUMN events.nearby_event IS 'Stores nearby event search results from Google Serp API';

-- Create an index on nearby_event for faster queries (optional, useful for searching within JSONB)
CREATE INDEX IF NOT EXISTS idx_events_nearby_event ON events USING GIN (nearby_event);

-- Example of what the nearby_event structure might look like:
-- {
--   "search_query": "events near Times Square",
--   "search_timestamp": "2025-10-09T10:00:00.000Z",
--   "results": [
--     {
--       "title": "Concert at Madison Square Garden",
--       "description": "...",
--       "location": "...",
--       "date": "...",
--       "source": "...",
--       "url": "..."
--     }
--   ],
--   "serp_metadata": {
--     "api_version": "1.0",
--     "total_results": 10,
--     "search_parameters": {...}
--   }
-- }

