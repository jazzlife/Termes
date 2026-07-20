create table if not exists orchestration_blueprints (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  version integer not null,
  domain text not null check (domain in ('software', 'security', 'operations', 'data', 'research', 'product', 'general')),
  secondary_domains jsonb not null default '[]'::jsonb,
  weight text not null check (weight in ('light', 'standard', 'heavy', 'critical')),
  risk_signals jsonb not null default '[]'::jsonb,
  collaboration text not null check (collaboration in ('direct', 'parallel-review', 'parallel-synthesis')),
  require_evidence boolean not null default true,
  require_independent_review boolean not null default false,
  status text not null default 'planned' check (status in ('planned', 'delegating', 'synthesizing', 'verified', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id)
);

create table if not exists specialist_assignments (
  id uuid primary key default gen_random_uuid(),
  blueprint_id uuid not null references orchestration_blueprints(id) on delete cascade,
  assignment_key text not null,
  role_name text not null,
  mission text not null,
  toolsets jsonb not null default '[]'::jsonb,
  required boolean not null default true,
  status text not null default 'planned' check (status in ('planned', 'running', 'completed', 'failed', 'cancelled')),
  hermes_subagent_id text,
  result_summary text,
  evidence jsonb not null default '[]'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (blueprint_id, assignment_key)
);

create index if not exists specialist_assignments_blueprint_status_idx
  on specialist_assignments(blueprint_id, status);
