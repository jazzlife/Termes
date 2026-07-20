alter table projects drop constraint if exists projects_key_key;

create unique index if not exists projects_workspace_key_unique
  on projects(workspace_id, key);
