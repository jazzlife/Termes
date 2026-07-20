update routing_sessions
set hermes_stored_session_id = null,
    hermes_live_session_id = null,
    status = 'recovering',
    updated_at = now()
where policy_version = 2;
