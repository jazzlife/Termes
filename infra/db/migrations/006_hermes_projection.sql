create table if not exists hermes_frame_events (
  id bigserial primary key,
  redis_stream_id text not null unique,
  account_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  direction text not null check (direction in ('upstream_to_client')),
  event_type text,
  hermes_session_id text,
  frame jsonb not null,
  created_at timestamptz not null
);

create index if not exists hermes_frame_events_session_idx
  on hermes_frame_events(account_id, hermes_session_id, created_at);
create index if not exists hermes_frame_events_task_idx
  on hermes_frame_events(task_id, created_at);

create table if not exists hermes_session_projections (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references users(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  hermes_session_id text not null,
  state jsonb not null,
  last_redis_stream_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (account_id, project_id, task_id, hermes_session_id)
);

create index if not exists hermes_session_projections_task_idx
  on hermes_session_projections(task_id, updated_at desc);
