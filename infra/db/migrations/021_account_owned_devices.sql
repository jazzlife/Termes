set lock_timeout = '10s';
set statement_timeout = '5min';

alter table devices
  add column if not exists account_id uuid;

update devices d
set account_id = aw.account_id
from projects p
join account_workspaces aw on aw.id = p.workspace_id
where p.id = d.project_id
  and d.account_id is null;

create or replace function termes_fill_device_account_scope()
returns trigger
language plpgsql
as $$
declare
  project_account_id uuid;
begin
  if new.project_id is not null then
    select aw.account_id
    into project_account_id
    from projects p
    join account_workspaces aw on aw.id = p.workspace_id
    where p.id = new.project_id;

    if project_account_id is null then
      raise exception 'Device project scope is invalid';
    end if;
    if new.account_id is null then
      new.account_id := project_account_id;
    elsif new.account_id <> project_account_id then
      raise exception 'Device account does not own its project';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists devices_fill_account_scope on devices;
create trigger devices_fill_account_scope
before insert or update of account_id, project_id on devices
for each row execute function termes_fill_device_account_scope();

alter table devices
  alter column account_id set not null;

create unique index if not exists devices_id_account_unique
  on devices(id, account_id);
create index if not exists devices_account_status_idx
  on devices(account_id, platform, status, updated_at desc);

alter table devices
  drop constraint if exists devices_account_id_fkey;
alter table devices
  add constraint devices_account_id_fkey
  foreign key (account_id) references users(id) on delete cascade;

alter table devices
  alter column project_id drop not null;

alter table desktop_connectors
  drop constraint if exists desktop_connectors_device_id_project_id_fkey;

alter table device_commands
  drop constraint if exists device_commands_device_id_project_id_fkey;

alter table desktop_connectors
  alter column workspace_id drop not null,
  alter column project_id drop not null;

update devices d
set project_id = null,
    updated_at = now()
where d.transport = 'connector'
  and d.project_id is not null;

update desktop_connectors
set workspace_id = null,
    project_id = null,
    updated_at = now()
where workspace_id is not null
   or project_id is not null;

alter table devices
  add constraint devices_owner_scope_check
  check (
    (transport = 'connector' and project_id is null)
    or
    (transport <> 'connector' and project_id is not null)
  ) not valid;

alter table devices
  validate constraint devices_owner_scope_check;

alter table desktop_connectors
  drop constraint if exists desktop_connectors_device_account_fkey;
alter table desktop_connectors
  add constraint desktop_connectors_device_account_fkey
  foreign key (device_id, account_id) references devices(id, account_id);

with ranked as (
  select id,
         row_number() over (
           partition by account_id, machine_fingerprint
           order by (revoked_at is null) desc, updated_at desc, created_at desc, id desc
         ) as position
  from desktop_connectors
)
update desktop_connectors dc
set status = 'revoked',
    revoked_at = coalesce(dc.revoked_at, now()),
    disconnected_at = coalesce(dc.disconnected_at, now()),
    updated_at = now()
from ranked r
where r.id = dc.id
  and r.position > 1
  and dc.revoked_at is null;

update devices d
set status = 'offline', updated_at = now()
where d.id in (
  select dc.device_id
  from desktop_connectors dc
  where dc.revoked_at is not null
)
and not exists (
  select 1
  from desktop_connectors active
  where active.device_id = d.id
    and active.revoked_at is null
);

drop index if exists desktop_connectors_active_machine_unique;
create unique index if not exists desktop_connectors_active_account_machine_unique
  on desktop_connectors(account_id, machine_fingerprint)
  where revoked_at is null;

alter table desktop_connector_receipts
  drop constraint if exists desktop_connector_receipts_state_check;
alter table desktop_connector_receipts
  add constraint desktop_connector_receipts_state_check
  check (state in (
    'dispatched', 'acknowledged', 'processing', 'completed', 'failed', 'refused', 'cancelled', 'unknown'
  )) not valid;
alter table desktop_connector_receipts
  validate constraint desktop_connector_receipts_state_check;

alter table device_commands
  add column if not exists account_id uuid,
  add column if not exists workspace_id uuid;

update device_commands dc
set account_id = aw.account_id,
    workspace_id = p.workspace_id
from projects p
join account_workspaces aw on aw.id = p.workspace_id
where p.id = dc.project_id
  and (dc.account_id is null or dc.workspace_id is null);

create or replace function termes_fill_device_command_scope()
returns trigger
language plpgsql
as $$
declare
  project_account_id uuid;
  project_workspace_id uuid;
  device_account_id uuid;
  device_project_id uuid;
  device_transport text;
begin
  select aw.account_id, p.workspace_id
  into project_account_id, project_workspace_id
  from projects p
  join account_workspaces aw on aw.id = p.workspace_id
  where p.id = new.project_id;

  if project_account_id is null or project_workspace_id is null then
    raise exception 'Device command project scope is invalid';
  end if;
  if new.account_id is null then
    new.account_id := project_account_id;
  elsif new.account_id <> project_account_id then
    raise exception 'Device command account does not own its project';
  end if;
  if new.workspace_id is null then
    new.workspace_id := project_workspace_id;
  elsif new.workspace_id <> project_workspace_id then
    raise exception 'Device command workspace does not own its project';
  end if;

  select account_id, project_id, transport
  into device_account_id, device_project_id, device_transport
  from devices
  where id = new.device_id;

  if device_account_id is null then
    raise exception 'Device command device scope is invalid';
  end if;
  if device_account_id <> new.account_id then
    raise exception 'Device command account does not own its device';
  end if;
  if device_transport = 'connector' then
    if device_project_id is not null then
      raise exception 'Connector device must use account ownership';
    end if;
  elsif device_project_id is distinct from new.project_id then
    raise exception 'Project device command must use the device project';
  end if;

  return new;
end;
$$;

drop trigger if exists device_commands_fill_scope on device_commands;
create trigger device_commands_fill_scope
before insert or update of account_id, workspace_id, project_id, device_id on device_commands
for each row execute function termes_fill_device_command_scope();

alter table device_commands
  alter column account_id set not null,
  alter column workspace_id set not null;

create unique index if not exists device_commands_id_account_workspace_unique
  on device_commands(id, account_id, workspace_id);
create index if not exists device_commands_scope_created_idx
  on device_commands(account_id, workspace_id, project_id, created_at desc);

alter table device_commands
  drop constraint if exists device_commands_account_workspace_fkey;
alter table device_commands
  add constraint device_commands_account_workspace_fkey
  foreign key (workspace_id, account_id)
  references account_workspaces(id, account_id);

alter table device_commands
  drop constraint if exists device_commands_project_workspace_fkey;
alter table device_commands
  add constraint device_commands_project_workspace_fkey
  foreign key (project_id, workspace_id)
  references projects(id, workspace_id);

alter table device_commands
  drop constraint if exists device_commands_device_account_fkey;
alter table device_commands
  add constraint device_commands_device_account_fkey
  foreign key (device_id, account_id)
  references devices(id, account_id);

comment on column devices.account_id is
  'Authoritative account owner. Connector devices are account-wide; other transports retain project scope.';
comment on column device_commands.workspace_id is
  'Workspace that invoked the account-owned device command.';
comment on column desktop_connectors.workspace_id is
  'Nullable legacy registration origin; connector authorization is account-scoped.';
comment on column desktop_connectors.project_id is
  'Nullable legacy registration origin; command results belong to the invoking project.';
