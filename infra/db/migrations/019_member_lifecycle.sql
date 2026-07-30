create table if not exists account_members (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references users(id) on delete cascade,
  login_id text not null,
  email text not null,
  display_name text not null,
  status text not null default 'pending' check (status in ('pending', 'approved')),
  is_account_owner boolean not null default false,
  auth_session_version bigint not null default 0,
  approved_at timestamptz,
  approved_by uuid references account_members(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'pending' and approved_at is null and approved_by is null)
    or (status = 'approved' and account_id is not null and approved_at is not null))
);

insert into account_members (
  id,
  account_id,
  login_id,
  email,
  display_name,
  status,
  is_account_owner,
  approved_at,
  created_at,
  updated_at
)
select
  u.id,
  u.id,
  lower(btrim(u.login_id)),
  lower(btrim(u.email)),
  u.display_name,
  'approved',
  true,
  u.created_at,
  u.created_at,
  u.created_at
from users u
on conflict (id) do nothing;

alter table account_members
  add constraint account_members_login_id_not_blank check (btrim(login_id) <> ''),
  add constraint account_members_email_not_blank check (btrim(email) <> '');

create unique index account_members_login_id_normalized_unique
  on account_members(lower(btrim(login_id)));

create unique index account_members_email_normalized_unique
  on account_members(lower(btrim(email)));

create index account_members_pending_created_idx
  on account_members(account_id, status, created_at)
  where status = 'pending';

create table if not exists account_member_credentials (
  member_id uuid primary key references account_members(id) on delete cascade,
  password_hash text not null,
  created_at timestamptz not null default now(),
  password_changed_at timestamptz not null default now()
);
