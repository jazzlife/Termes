alter table event_outbox
  add column if not exists dead_lettered_at timestamptz;

drop index if exists event_outbox_pending_idx;
create index event_outbox_pending_idx
  on event_outbox(available_at, id)
  where published_at is null and dead_lettered_at is null;

create index if not exists event_outbox_dead_letter_idx
  on event_outbox(dead_lettered_at, id)
  where dead_lettered_at is not null;
