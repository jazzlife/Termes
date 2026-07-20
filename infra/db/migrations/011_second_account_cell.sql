insert into users (id, email, display_name)
values ('00000000-0000-0000-0000-000000000002', 'cell-b@termes.local', 'Cell B')
on conflict (id) do nothing;

update account_workspaces
set root_path = '/data/docker_data/termes/workspaces/users/00000000-0000-0000-0000-000000000001',
    updated_at = now()
where id = '10000000-0000-0000-0000-000000000001';

insert into account_workspaces (id, account_id, key, root_path)
values (
  '10000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000002',
  'default',
  '/data/docker_data/termes/workspaces/users/00000000-0000-0000-0000-000000000002'
)
on conflict (id) do nothing;

insert into runtime_cells (
  id, account_id, workspace_id, cell_key, hermes_home, state_root, resource_policy
)
values (
  '20000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000002',
  'default',
  '/data/docker_data/termes/account-cells/00000000-0000-0000-0000-000000000002/hermes',
  '/data/docker_data/termes/account-cells/00000000-0000-0000-0000-000000000002',
  '{"cpus":4,"memoryMb":8192,"pids":512,"nofile":4096,"maxConcurrentRuns":3}'::jsonb
)
on conflict (id) do nothing;

insert into projects (id, workspace_id, key, name, description)
values (
  '30000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000002',
  'account-b-isolation',
  'Account B Isolation Fixture',
  'Account Cell B runtime and cross-account isolation verification project.'
)
on conflict (id) do nothing;

insert into project_members (project_id, user_id, role)
values (
  '30000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000002',
  'owner'
)
on conflict (project_id, user_id) do nothing;

insert into workspace_roots (workspace_id, project_id, host_path)
select
  '10000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000002',
  '/data/docker_data/termes/workspaces/projects/account-b-isolation'
where not exists (
  select 1 from workspace_roots where project_id = '30000000-0000-0000-0000-000000000002'
);
