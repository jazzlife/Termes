create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  key text not null,
  name text not null,
  platform text not null check (platform in ('android', 'tizen', 'linux', 'windows', 'local_mock')),
  transport text not null check (transport in ('adb', 'sdb', 'ssh', 'winrm', 'local_mock')),
  endpoint text,
  labels jsonb not null default '{}'::jsonb,
  status text not null default 'unknown' check (status in ('unknown', 'offline', 'online', 'busy', 'error')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, key)
);

create index if not exists devices_project_platform_idx on devices(project_id, platform);
create index if not exists devices_status_idx on devices(status);

create table if not exists device_sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices(id) on delete cascade,
  lease_owner text not null,
  status text not null default 'created' check (status in ('created', 'active', 'expired', 'closed', 'error')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  closed_at timestamptz
);

create index if not exists device_sessions_device_status_idx on device_sessions(device_id, status);

create table if not exists device_commands (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  device_id uuid not null references devices(id) on delete cascade,
  action text not null,
  params jsonb not null default '{}'::jsonb,
  status text not null default 'created' check (status in ('created', 'queued', 'running', 'completed', 'failed', 'cancelled', 'blocked')),
  approval_id uuid references approvals(id) on delete set null,
  stdout text,
  stderr text,
  exit_code integer,
  artifact_uri text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists device_commands_project_created_idx on device_commands(project_id, created_at desc);
create index if not exists device_commands_task_created_idx on device_commands(task_id, created_at desc);
create index if not exists device_commands_device_created_idx on device_commands(device_id, created_at desc);
create index if not exists device_commands_status_idx on device_commands(status);

create table if not exists capability_packages (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text not null,
  platforms jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists task_plans (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  selected_capabilities jsonb not null default '[]'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  status text not null default 'created' check (status in ('created', 'running', 'completed', 'failed', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id)
);

create table if not exists memory_records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  kind text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists memory_records_project_created_idx on memory_records(project_id, created_at desc);
create index if not exists memory_records_task_created_idx on memory_records(task_id, created_at desc);

create table if not exists verification_results (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  device_command_id uuid references device_commands(id) on delete set null,
  kind text not null,
  status text not null default 'unknown' check (status in ('passed', 'failed', 'warning', 'unknown')),
  confidence numeric(4,3) not null default 0 check (confidence >= 0 and confidence <= 1),
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists verification_results_task_created_idx on verification_results(task_id, created_at desc);
create index if not exists verification_results_command_idx on verification_results(device_command_id);

insert into capability_packages (key, name, description, platforms, actions)
values
  (
    'github-project-bootstrap',
    'GitHub Project Bootstrap',
    'Clone or register a GitHub repository and prepare a Termes project workspace.',
    '[]'::jsonb,
    '["github.clone", "project.folder.register"]'::jsonb
  ),
  (
    'runner-worktree-verification',
    'Runner Worktree Verification',
    'Create a task worktree and verify changed files, artifacts, and checkpoints.',
    '[]'::jsonb,
    '["runner.run", "verification.check"]'::jsonb
  ),
  (
    'web-pwa-verification',
    'Mobile PWA Verification',
    'Verify the Termes mobile PWA with browser and viewport checks.',
    '[]'::jsonb,
    '["web.playwright", "verification.check"]'::jsonb
  ),
  (
    'linux-ssh-ops',
    'Linux SSH Operations',
    'Run safe Linux operational commands through SSH.',
    '["linux"]'::jsonb,
    '["linux.system.info", "linux.shell", "linux.service.status", "linux.journal.query"]'::jsonb
  ),
  (
    'windows-powershell-ops',
    'Windows PowerShell Operations',
    'Run safe Windows operational commands through WinRM or OpenSSH.',
    '["windows"]'::jsonb,
    '["windows.system.info", "windows.powershell", "windows.service.status", "windows.eventlog.query"]'::jsonb
  ),
  (
    'android-adb-debug',
    'Android ADB Debug',
    'Inspect Android devices, run safe shell commands, and collect logcat output.',
    '["android"]'::jsonb,
    '["android.system.info", "android.shell", "android.logcat"]'::jsonb
  ),
  (
    'tizen-sdb-debug',
    'Tizen SDB Debug',
    'Inspect Tizen devices, run safe shell commands, and collect dlog output.',
    '["tizen"]'::jsonb,
    '["tizen.system.info", "tizen.shell", "tizen.dlog"]'::jsonb
  ),
  (
    'local-mock-device',
    'Local Mock Device',
    'Exercise the full device command path without external devices.',
    '["local_mock"]'::jsonb,
    '["local_mock.health", "local_mock.echo", "local_mock.fail", "local_mock.sleep"]'::jsonb
  )
on conflict (key) do update
set
  name = excluded.name,
  description = excluded.description,
  platforms = excluded.platforms,
  actions = excluded.actions,
  enabled = true,
  updated_at = now();

insert into devices (
  project_id,
  key,
  name,
  platform,
  transport,
  endpoint,
  labels,
  status,
  last_seen_at
)
values (
  '00000000-0000-0000-0000-000000000101',
  'local-mock',
  'Local Mock Device',
  'local_mock',
  'local_mock',
  'local://termes/device-gateway',
  '{"source":"migration","purpose":"smoke"}'::jsonb,
  'online',
  now()
)
on conflict (project_id, key) do update
set
  name = excluded.name,
  platform = excluded.platform,
  transport = excluded.transport,
  endpoint = excluded.endpoint,
  labels = excluded.labels,
  status = excluded.status,
  last_seen_at = now(),
  updated_at = now();
