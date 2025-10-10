-- ============================================================================
-- Push Notifications Tables Migration
-- ============================================================================
-- Description: Creates tables for managing push notification subscriptions
--              and tracking notification delivery
-- Created: 2025-01-10
-- ============================================================================

-- ============================================================================
-- Table: push_subscriptions
-- Purpose: Store browser push notification subscriptions for events
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Optional: Link to authenticated user (if you add user auth later)
  user_id UUID,  -- REFERENCES users(id) ON DELETE CASCADE (add when user table exists)
  
  -- Link to event
  event_id TEXT NOT NULL,  -- Using TEXT to match your events.event_id type
  
  -- Push Subscription Data (from browser PushSubscription object)
  endpoint TEXT NOT NULL,     -- Browser push endpoint URL (must be unique)
  p256dh TEXT NOT NULL,       -- Encryption key (public key for p256dh)
  auth TEXT NOT NULL,         -- Authentication secret
  
  -- Metadata
  user_agent TEXT,            -- Browser/device info for analytics
  ip_address INET,            -- User's IP address for security/analytics
  subscribed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_notification_sent TIMESTAMP WITH TIME ZONE,
  notification_count INTEGER DEFAULT 0,
  
  -- Status and Error Tracking
  is_active BOOLEAN DEFAULT TRUE,
  failed_attempts INTEGER DEFAULT 0,  -- Track consecutive delivery failures
  last_error TEXT,                    -- Last error message
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- Indexes for push_subscriptions
-- ============================================================================
-- Fast lookups by event (most common query)
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_event_id 
  ON public.push_subscriptions(event_id);

-- Fast lookups by user (when user auth is added)
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id 
  ON public.push_subscriptions(user_id) 
  WHERE user_id IS NOT NULL;

-- Fast lookups for active subscriptions only (partial index for performance)
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_active 
  ON public.push_subscriptions(is_active, event_id) 
  WHERE is_active = TRUE;

-- Fast lookups by endpoint (for unsubscribe)
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint 
  ON public.push_subscriptions(endpoint);

-- Unique constraint: One endpoint per event (prevents duplicate subscriptions)
CREATE UNIQUE INDEX IF NOT EXISTS unique_event_endpoint 
  ON public.push_subscriptions(event_id, endpoint);

-- ============================================================================
-- Table: notification_logs
-- Purpose: Track all sent notifications for analytics and debugging
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Links
  subscription_id UUID REFERENCES public.push_subscriptions(id) ON DELETE CASCADE,
  event_id TEXT,  -- Denormalized for faster queries
  
  -- Notification Content
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB,  -- Additional payload (congestion data, etc.)
  
  -- Delivery Status
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'sent',  -- 'sent', 'delivered', 'failed'
  error_message TEXT,
  
  -- User Engagement Analytics
  clicked BOOLEAN DEFAULT FALSE,
  clicked_at TIMESTAMP WITH TIME ZONE,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- Indexes for notification_logs
-- ============================================================================
-- Fast lookups by event (for analytics)
CREATE INDEX IF NOT EXISTS idx_notification_logs_event_id 
  ON public.notification_logs(event_id);

-- Fast lookups by subscription (for user's notification history)
CREATE INDEX IF NOT EXISTS idx_notification_logs_subscription_id 
  ON public.notification_logs(subscription_id);

-- Fast time-based queries (for recent notifications)
CREATE INDEX IF NOT EXISTS idx_notification_logs_sent_at 
  ON public.notification_logs(sent_at DESC);

-- Fast status queries (for delivery analytics)
CREATE INDEX IF NOT EXISTS idx_notification_logs_status 
  ON public.notification_logs(status);

-- ============================================================================
-- Comments for Documentation
-- ============================================================================
COMMENT ON TABLE public.push_subscriptions IS 
  'Stores browser push notification subscriptions for event updates and alerts';

COMMENT ON COLUMN public.push_subscriptions.endpoint IS 
  'Unique browser push endpoint URL provided by the browser Push API';

COMMENT ON COLUMN public.push_subscriptions.p256dh IS 
  'Public encryption key (base64 encoded) for encrypting push messages';

COMMENT ON COLUMN public.push_subscriptions.auth IS 
  'Authentication secret (base64 encoded) for message authentication';

COMMENT ON COLUMN public.push_subscriptions.is_active IS 
  'FALSE if subscription expired or user unsubscribed';

COMMENT ON COLUMN public.push_subscriptions.failed_attempts IS 
  'Consecutive delivery failures - auto-deactivate after threshold';

COMMENT ON TABLE public.notification_logs IS 
  'Audit log of all push notifications sent, for analytics and debugging';

-- ============================================================================
-- Function: Auto-update updated_at timestamp
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for push_subscriptions
DROP TRIGGER IF EXISTS update_push_subscriptions_updated_at ON public.push_subscriptions;
CREATE TRIGGER update_push_subscriptions_updated_at
  BEFORE UPDATE ON public.push_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Cleanup Function: Remove inactive subscriptions
-- ============================================================================
-- Run this periodically (e.g., weekly) to clean up old inactive subscriptions
CREATE OR REPLACE FUNCTION cleanup_inactive_subscriptions()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Delete subscriptions that have been inactive for 90 days
  -- and have more than 10 failed attempts
  DELETE FROM public.push_subscriptions
  WHERE is_active = FALSE
    AND updated_at < NOW() - INTERVAL '90 days'
    AND failed_attempts > 10;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_inactive_subscriptions() IS 
  'Removes inactive subscriptions older than 90 days with multiple failures';

-- ============================================================================
-- Analytics Views (Optional - for easy querying)
-- ============================================================================

-- View: Active subscriptions summary
CREATE OR REPLACE VIEW push_subscriptions_summary AS
SELECT 
  event_id,
  COUNT(*) as total_subscriptions,
  COUNT(CASE WHEN is_active THEN 1 END) as active_subscriptions,
  COUNT(CASE WHEN NOT is_active THEN 1 END) as inactive_subscriptions,
  AVG(notification_count) as avg_notifications_per_user,
  MAX(subscribed_at) as latest_subscription,
  MIN(subscribed_at) as earliest_subscription
FROM public.push_subscriptions
GROUP BY event_id;

COMMENT ON VIEW push_subscriptions_summary IS 
  'Summary statistics of push subscriptions per event';

-- View: Notification delivery stats
CREATE OR REPLACE VIEW notification_delivery_stats AS
SELECT 
  event_id,
  DATE(sent_at) as date,
  COUNT(*) as total_sent,
  COUNT(CASE WHEN status = 'sent' THEN 1 END) as successful,
  COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
  COUNT(CASE WHEN clicked THEN 1 END) as clicked,
  ROUND(
    COUNT(CASE WHEN status = 'sent' THEN 1 END)::numeric / 
    NULLIF(COUNT(*), 0)::numeric * 100, 
    2
  ) as success_rate_pct,
  ROUND(
    COUNT(CASE WHEN clicked THEN 1 END)::numeric / 
    NULLIF(COUNT(CASE WHEN status = 'sent' THEN 1 END), 0)::numeric * 100, 
    2
  ) as click_rate_pct
FROM public.notification_logs
GROUP BY event_id, DATE(sent_at)
ORDER BY date DESC;

COMMENT ON VIEW notification_delivery_stats IS 
  'Daily notification delivery and engagement statistics per event';

-- ============================================================================
-- Grant Permissions (adjust based on your setup)
-- ============================================================================
-- Grant permissions to service role (Supabase)
GRANT ALL ON public.push_subscriptions TO service_role;
GRANT ALL ON public.notification_logs TO service_role;
GRANT SELECT ON push_subscriptions_summary TO service_role;
GRANT SELECT ON notification_delivery_stats TO service_role;

-- Grant permissions to authenticated users (optional - if you want client-side access)
-- GRANT SELECT, INSERT, UPDATE ON public.push_subscriptions TO authenticated;
-- GRANT SELECT ON public.notification_logs TO authenticated;

-- ============================================================================
-- Sample Queries for Testing
-- ============================================================================

-- Check active subscriptions per event
-- SELECT * FROM push_subscriptions_summary;

-- Check recent notification delivery
-- SELECT * FROM notification_delivery_stats WHERE date >= CURRENT_DATE - 7;

-- Find subscriptions with many failures (candidates for cleanup)
-- SELECT event_id, endpoint, failed_attempts, last_error, updated_at
-- FROM push_subscriptions
-- WHERE failed_attempts > 5
-- ORDER BY failed_attempts DESC;

-- Manually cleanup old subscriptions
-- SELECT cleanup_inactive_subscriptions();

-- ============================================================================
-- Migration Complete
-- ============================================================================

