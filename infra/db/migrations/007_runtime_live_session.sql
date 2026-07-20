alter table runtime_sessions
  add column if not exists hermes_live_session_id text;

create index if not exists runtime_sessions_live_session_idx
  on runtime_sessions(hermes_live_session_id)
  where hermes_live_session_id is not null;
