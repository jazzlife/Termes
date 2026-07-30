alter table devices drop constraint if exists devices_platform_check;
alter table devices
  add constraint devices_platform_check
  check (platform in ('android', 'tizen', 'linux', 'windows', 'macos', 'local_mock')) not valid;
alter table devices validate constraint devices_platform_check;

alter table devices drop constraint if exists devices_transport_check;
alter table devices
  add constraint devices_transport_check
  check (transport in ('adb', 'sdb', 'ssh', 'winrm', 'connector', 'local_mock')) not valid;
alter table devices validate constraint devices_transport_check;

alter table device_commands drop constraint if exists device_commands_status_check;
alter table device_commands
  add constraint device_commands_status_check
  check (status in ('created', 'queued', 'running', 'completed', 'failed', 'cancelled', 'blocked', 'unknown')) not valid;
alter table device_commands validate constraint device_commands_status_check;

create unique index if not exists account_workspaces_id_account_unique
  on account_workspaces(id, account_id);
create unique index if not exists projects_id_workspace_unique
  on projects(id, workspace_id);
create unique index if not exists devices_id_project_unique
  on devices(id, project_id);

create table if not exists desktop_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references account_workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  created_by uuid not null references account_members(id) on delete cascade,
  code_hash bytea not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, account_id)
    references account_workspaces(id, account_id),
  foreign key (project_id, workspace_id)
    references projects(id, workspace_id)
);

create index if not exists desktop_pairing_codes_scope_created_idx
  on desktop_pairing_codes(account_id, workspace_id, project_id, created_at desc);
create index if not exists desktop_pairing_codes_expiry_idx
  on desktop_pairing_codes(expires_at)
  where consumed_at is null;

create table if not exists desktop_connectors (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references account_workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  device_id uuid not null references devices(id) on delete cascade,
  name text not null,
  platform text not null check (platform in ('windows', 'macos')),
  machine_fingerprint text not null,
  public_key text,
  token_hash bytea not null unique,
  credential_version integer not null default 1 check (credential_version > 0),
  protocol_version integer not null default 1 check (protocol_version > 0),
  app_version text not null,
  capabilities jsonb not null default '[]'::jsonb,
  permissions jsonb not null default '{}'::jsonb,
  status text not null default 'offline' check (status in ('offline', 'connecting', 'online', 'busy', 'error', 'revoked')),
  command_sequence bigint not null default 0 check (command_sequence >= 0),
  last_connected_at timestamptz,
  last_heartbeat_at timestamptz,
  disconnected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id),
  foreign key (workspace_id, account_id)
    references account_workspaces(id, account_id),
  foreign key (project_id, workspace_id)
    references projects(id, workspace_id),
  foreign key (device_id, project_id)
    references devices(id, project_id)
);

create unique index if not exists desktop_connectors_active_machine_unique
  on desktop_connectors(workspace_id, machine_fingerprint)
  where revoked_at is null;
create index if not exists desktop_connectors_scope_status_idx
  on desktop_connectors(account_id, workspace_id, project_id, status, updated_at desc);
create index if not exists desktop_connectors_heartbeat_idx
  on desktop_connectors(last_heartbeat_at)
  where revoked_at is null;

create table if not exists desktop_connector_receipts (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references desktop_connectors(id) on delete cascade,
  device_command_id uuid not null references device_commands(id) on delete cascade,
  sequence bigint not null check (sequence > 0),
  request_hash text not null,
  state text not null default 'dispatched'
    check (state in ('dispatched', 'acknowledged', 'completed', 'failed', 'refused', 'cancelled', 'unknown')),
  acknowledged_at timestamptz,
  completed_at timestamptz,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connector_id, sequence),
  unique (device_command_id)
);

create index if not exists desktop_connector_receipts_connector_created_idx
  on desktop_connector_receipts(connector_id, created_at desc);
create index if not exists desktop_connector_receipts_state_idx
  on desktop_connector_receipts(state, updated_at desc);

insert into capability_packages (key, name, description, platforms, actions)
values
  (
    'windows-desktop-connector',
    'Windows Desktop Connector',
    'Observe, control, and diagnose a paired Windows desktop through the outbound Termes connector.',
    '["windows"]'::jsonb,
    '["windows.system.info", "windows.process.list", "windows.screen.capture", "windows.accessibility.snapshot", "windows.input.click", "windows.input.type", "windows.app.launch", "windows.app.terminate", "windows.logs.query", "windows.debug.process"]'::jsonb
  ),
  (
    'macos-desktop-connector',
    'macOS Desktop Connector',
    'Observe, control, and diagnose a paired macOS desktop through the outbound Termes connector.',
    '["macos"]'::jsonb,
    '["macos.system.info", "macos.process.list", "macos.screen.capture", "macos.accessibility.snapshot", "macos.input.click", "macos.input.type", "macos.app.launch", "macos.app.terminate", "macos.logs.query", "macos.debug.process"]'::jsonb
  )
on conflict (key) do update
set
  name = excluded.name,
  description = excluded.description,
  platforms = excluded.platforms,
  actions = excluded.actions,
  enabled = true,
  updated_at = now();
