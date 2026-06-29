create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  source text not null default 'termes',
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_task_created_idx on chat_messages(task_id, created_at);
