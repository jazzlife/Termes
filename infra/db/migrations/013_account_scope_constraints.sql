update workspace_roots
set host_path = '/data/docker_data/termes/workspaces/users/00000000-0000-0000-0000-000000000002/projects/account-b-isolation'
where project_id = '30000000-0000-0000-0000-000000000002';

create unique index if not exists projects_id_workspace_unique
  on projects(id, workspace_id);

create unique index if not exists tasks_id_account_workspace_unique
  on tasks(id, account_id, workspace_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_roots_project_scope_fkey') then
    alter table workspace_roots
      add constraint workspace_roots_project_scope_fkey
      foreign key (project_id, workspace_id) references projects(id, workspace_id)
      not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_project_scope_fkey') then
    alter table tasks
      add constraint tasks_project_scope_fkey
      foreign key (project_id, workspace_id) references projects(id, workspace_id)
      not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'runtime_sessions_task_scope_fkey') then
    alter table runtime_sessions
      add constraint runtime_sessions_task_scope_fkey
      foreign key (task_id, account_id, workspace_id) references tasks(id, account_id, workspace_id)
      not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'artifacts_task_scope_fkey') then
    alter table artifacts
      add constraint artifacts_task_scope_fkey
      foreign key (task_id, account_id, workspace_id) references tasks(id, account_id, workspace_id)
      not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'events_task_scope_fkey') then
    alter table events
      add constraint events_task_scope_fkey
      foreign key (task_id, account_id, workspace_id) references tasks(id, account_id, workspace_id)
      not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hermes_frames_task_scope_fkey') then
    alter table hermes_frame_events
      add constraint hermes_frames_task_scope_fkey
      foreign key (task_id, account_id, workspace_id) references tasks(id, account_id, workspace_id)
      not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hermes_projections_task_scope_fkey') then
    alter table hermes_session_projections
      add constraint hermes_projections_task_scope_fkey
      foreign key (task_id, account_id, workspace_id) references tasks(id, account_id, workspace_id)
      not valid;
  end if;
end $$;

alter table workspace_roots validate constraint workspace_roots_project_scope_fkey;
alter table tasks validate constraint tasks_project_scope_fkey;
alter table runtime_sessions validate constraint runtime_sessions_task_scope_fkey;
alter table artifacts validate constraint artifacts_task_scope_fkey;
alter table events validate constraint events_task_scope_fkey;
alter table hermes_frame_events validate constraint hermes_frames_task_scope_fkey;
alter table hermes_session_projections validate constraint hermes_projections_task_scope_fkey;
