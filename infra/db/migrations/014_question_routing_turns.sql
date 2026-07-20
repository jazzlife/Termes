create unique index if not exists runtime_cells_id_account_workspace_unique
  on runtime_cells(id, account_id, workspace_id);

create table if not exists task_turns (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references users(id),
  workspace_id uuid not null references account_workspaces(id),
  runtime_cell_id uuid not null references runtime_cells(id),
  project_id uuid not null references projects(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  user_message_id uuid not null unique references chat_messages(id) on delete cascade,
  status text not null default 'requested' check (status in (
    'requested', 'routing', 'routed', 'running', 'waiting_approval',
    'completed', 'failed', 'cancelled'
  )),
  failure_code text,
  failure_message text,
  created_at timestamptz not null default now(),
  routed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  foreign key (task_id, account_id, workspace_id)
    references tasks(id, account_id, workspace_id),
  foreign key (runtime_cell_id, account_id, workspace_id)
    references runtime_cells(id, account_id, workspace_id),
  foreign key (project_id, workspace_id)
    references projects(id, workspace_id)
);

create index if not exists task_turns_cell_status_created_idx
  on task_turns(runtime_cell_id, status, created_at);
create index if not exists task_turns_task_created_idx
  on task_turns(task_id, created_at);

create table if not exists routing_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references users(id),
  workspace_id uuid not null references account_workspaces(id),
  runtime_cell_id uuid not null references runtime_cells(id),
  policy_version integer not null,
  hermes_stored_session_id text,
  hermes_live_session_id text,
  status text not null default 'creating' check (status in (
    'creating', 'warming', 'ready', 'busy', 'recovering', 'failed', 'closed'
  )),
  last_ready_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (runtime_cell_id, policy_version),
  foreign key (runtime_cell_id, account_id, workspace_id)
    references runtime_cells(id, account_id, workspace_id)
);

create table if not exists routing_attempts (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null references task_turns(id) on delete cascade,
  routing_session_id uuid references routing_sessions(id),
  attempt integer not null,
  status text not null check (status in ('running', 'valid', 'invalid', 'failed')),
  duration_ms integer,
  error_code text,
  output_hash text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (turn_id, attempt)
);

create table if not exists route_decisions (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null unique references task_turns(id) on delete cascade,
  routing_session_id uuid references routing_sessions(id),
  policy_version integer not null,
  source text not null check (source in ('deterministic-policy', 'routing-specialist')),
  intent text not null,
  route text not null,
  primary_domain text not null,
  secondary_domains jsonb not null default '[]'::jsonb,
  risk_signals jsonb not null default '[]'::jsonb,
  evidence_requirement text not null,
  context_requirement text not null,
  reason_codes jsonb not null default '[]'::jsonb,
  routing_duration_ms integer not null,
  decision_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists turn_dispatch_outbox (
  turn_id uuid primary key references task_turns(id) on delete cascade,
  runtime_cell_id uuid not null references runtime_cells(id),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  enqueued_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
