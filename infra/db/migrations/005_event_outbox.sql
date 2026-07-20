create table if not exists event_outbox (
  id bigserial primary key,
  event_id uuid not null unique references events(id) on delete cascade,
  envelope jsonb not null,
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  published_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists event_outbox_pending_idx
  on event_outbox(available_at, id)
  where published_at is null;
