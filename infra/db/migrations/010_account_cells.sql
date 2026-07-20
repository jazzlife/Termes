create table if not exists account_workspaces (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references users(id) on delete cascade,
  key text not null,
  root_path text not null unique,
  status text not null default 'active' check (status in ('active', 'disabled', 'deleting')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, key)
);

insert into account_workspaces (id, account_id, key, root_path)
values (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'default',
  '/data/docker_data/termes/workspaces'
)
on conflict (id) do nothing;

create table if not exists runtime_cells (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references account_workspaces(id) on delete cascade,
  cell_key text not null,
  status text not null default 'active' check (status in ('provisioning', 'active', 'draining', 'stopped', 'failed')),
  hermes_home text not null,
  state_root text not null,
  resource_policy jsonb not null default '{}'::jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, cell_key),
  unique (workspace_id)
);

insert into runtime_cells (
  id, account_id, workspace_id, cell_key, hermes_home, state_root, resource_policy
)
values (
  '20000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'default',
  '/data/docker_data/termes/hermes-agent',
  '/data/docker_data/termes/account-cells/00000000-0000-0000-0000-000000000001',
  '{"cpus":4,"memoryMb":8192,"pids":512,"nofile":4096,"maxConcurrentRuns":3}'::jsonb
)
on conflict (id) do nothing;

alter table projects add column if not exists workspace_id uuid references account_workspaces(id);
update projects set workspace_id = '10000000-0000-0000-0000-000000000001' where workspace_id is null;
alter table projects alter column workspace_id set not null;

alter table workspace_roots add column if not exists workspace_id uuid references account_workspaces(id);
update workspace_roots set workspace_id = '10000000-0000-0000-0000-000000000001' where workspace_id is null;
alter table workspace_roots alter column workspace_id set not null;

alter table tasks add column if not exists account_id uuid references users(id);
alter table tasks add column if not exists workspace_id uuid references account_workspaces(id);
update tasks t
set account_id = pm.user_id,
    workspace_id = p.workspace_id
from projects p
join lateral (
  select user_id from project_members where project_id = p.id and role = 'owner' order by created_at asc limit 1
) pm on true
where t.project_id = p.id and (t.account_id is null or t.workspace_id is null);
alter table tasks alter column account_id set not null;
alter table tasks alter column workspace_id set not null;

alter table runtime_profiles add column if not exists account_id uuid references users(id);
alter table runtime_profiles add column if not exists workspace_id uuid references account_workspaces(id);
alter table runtime_profiles add column if not exists runtime_cell_id uuid references runtime_cells(id);
update runtime_profiles rp
set account_id = pm.user_id,
    workspace_id = p.workspace_id,
    runtime_cell_id = '20000000-0000-0000-0000-000000000001'
from projects p
join lateral (
  select user_id from project_members where project_id = p.id and role = 'owner' order by created_at asc limit 1
) pm on true
where rp.project_id = p.id;
alter table runtime_profiles alter column account_id set not null;
alter table runtime_profiles alter column workspace_id set not null;
alter table runtime_profiles alter column runtime_cell_id set not null;

alter table runtime_sessions add column if not exists account_id uuid references users(id);
alter table runtime_sessions add column if not exists workspace_id uuid references account_workspaces(id);
alter table runtime_sessions add column if not exists runtime_cell_id uuid references runtime_cells(id);
update runtime_sessions rs
set account_id = t.account_id,
    workspace_id = t.workspace_id,
    runtime_cell_id = '20000000-0000-0000-0000-000000000001'
from tasks t
where rs.task_id = t.id;
alter table runtime_sessions alter column account_id set not null;
alter table runtime_sessions alter column workspace_id set not null;
alter table runtime_sessions alter column runtime_cell_id set not null;

alter table artifacts add column if not exists account_id uuid references users(id);
alter table artifacts add column if not exists workspace_id uuid references account_workspaces(id);
update artifacts a
set account_id = t.account_id, workspace_id = t.workspace_id
from tasks t
where a.task_id = t.id and (a.account_id is null or a.workspace_id is null);

alter table events add column if not exists account_id uuid references users(id);
alter table events add column if not exists workspace_id uuid references account_workspaces(id);
update events e
set account_id = t.account_id, workspace_id = t.workspace_id
from tasks t
where e.task_id = t.id and (e.account_id is null or e.workspace_id is null);
update events e
set account_id = pm.user_id, workspace_id = p.workspace_id
from projects p
join lateral (
  select user_id from project_members where project_id = p.id and role = 'owner' order by created_at asc limit 1
) pm on true
where e.project_id = p.id and (e.account_id is null or e.workspace_id is null);

alter table hermes_frame_events add column if not exists workspace_id uuid references account_workspaces(id);
update hermes_frame_events set workspace_id = '10000000-0000-0000-0000-000000000001' where workspace_id is null;
alter table hermes_frame_events alter column workspace_id set not null;

alter table hermes_session_projections add column if not exists workspace_id uuid references account_workspaces(id);
update hermes_session_projections set workspace_id = '10000000-0000-0000-0000-000000000001' where workspace_id is null;
alter table hermes_session_projections alter column workspace_id set not null;

create index if not exists projects_workspace_idx on projects(workspace_id, updated_at desc);
create index if not exists tasks_account_workspace_idx on tasks(account_id, workspace_id, created_at desc);
create index if not exists runtime_sessions_cell_idx on runtime_sessions(runtime_cell_id, updated_at desc);
create index if not exists events_account_workspace_idx on events(account_id, workspace_id, created_at, id);
create index if not exists hermes_frames_workspace_idx on hermes_frame_events(account_id, workspace_id, created_at);
