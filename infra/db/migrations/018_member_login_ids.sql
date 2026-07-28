alter table users add column if not exists login_id text;

update users
set login_id = lower(split_part(btrim(email), '@', 1))
where login_id is null;

alter table users alter column login_id set not null;

alter table users
  add constraint users_login_id_not_blank
  check (btrim(login_id) <> '');

create unique index users_login_id_normalized_unique
  on users(lower(btrim(login_id)));
