create extension if not exists pgcrypto;

do $$
begin
  create type task_status as enum (
    'created',
    'queued',
    'running',
    'reviewing',
    'blocked',
    'completed',
    'failed',
    'cancelled'
  );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type agent_run_status as enum (
    'created',
    'running',
    'waiting_approval',
    'completed',
    'failed',
    'cancelled'
  );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type approval_status as enum (
    'requested',
    'approved',
    'rejected',
    'cancelled'
  );
exception
  when duplicate_object then null;
end $$;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'maintainer', 'developer', 'reviewer', 'observer')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table if not exists workspace_roots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  host_path text not null,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  instructions text not null,
  status task_status not null default 'created',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_project_status_idx on tasks(project_id, status);

create table if not exists task_nodes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  parent_id uuid references task_nodes(id) on delete cascade,
  title text not null,
  status task_status not null default 'created',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent_souls (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  role_name text not null,
  mission text not null,
  prompt text not null,
  allowed_paths jsonb not null default '[]'::jsonb,
  denied_paths jsonb not null default '[]'::jsonb,
  allowed_commands jsonb not null default '[]'::jsonb,
  denied_commands jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists runtime_profiles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  hermes_home text not null,
  codex_home text not null,
  codex_runtime_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

create table if not exists runtime_sessions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  runtime_profile_id uuid references runtime_profiles(id),
  hermes_session_id text,
  hermes_run_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists runner_containers (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  agent_id uuid,
  container_id text,
  worktree_path text not null,
  status text not null default 'created',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  soul_id uuid references agent_souls(id),
  runtime_session_id uuid references runtime_sessions(id),
  status agent_run_status not null default 'created',
  branch_name text,
  worktree_path text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  agent_run_id uuid references agent_runs(id),
  type text not null,
  status approval_status not null default 'requested',
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists checkpoints (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  agent_run_id uuid references agent_runs(id),
  summary text not null,
  git_commit_sha text,
  snapshot_uri text,
  checksum text,
  changed_files jsonb not null default '[]'::jsonb,
  test_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  kind text not null,
  uri text not null,
  checksum text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_task_created_idx on events(task_id, created_at);
create index if not exists events_created_idx on events(created_at);

create table if not exists secret_refs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  name text not null,
  provider text not null,
  ref text not null,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

create table if not exists policies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  name text not null,
  policy jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  actor_user_id uuid references users(id),
  action text not null,
  target_type text not null,
  target_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into users (id, email, display_name)
values ('00000000-0000-0000-0000-000000000001', 'master@termes.local', 'Master')
on conflict (id) do nothing;

insert into projects (id, key, name, description)
values (
  '00000000-0000-0000-0000-000000000101',
  'termes-mvp',
  'Termes MVP',
  'Initial Project First workspace for the Termes platform.'
)
on conflict (id) do nothing;

insert into project_members (project_id, user_id, role)
values (
  '00000000-0000-0000-0000-000000000101',
  '00000000-0000-0000-0000-000000000001',
  'owner'
)
on conflict (project_id, user_id) do nothing;

insert into workspace_roots (project_id, host_path)
values (
  '00000000-0000-0000-0000-000000000101',
  '/data/docker_data/termes/workspaces/users/00000000-0000-0000-0000-000000000001/projects/termes-mvp'
)
on conflict do nothing;
