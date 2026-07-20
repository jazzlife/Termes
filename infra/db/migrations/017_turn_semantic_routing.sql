alter table route_decisions
  add column if not exists semantic_frame jsonb not null default '{}'::jsonb;

alter table orchestration_blueprints
  add column if not exists turn_id uuid references task_turns(id) on delete cascade;

update orchestration_blueprints ob
set turn_id = (
  select tt.id
  from task_turns tt
  where tt.task_id = ob.task_id
  order by tt.created_at desc
  limit 1
)
where ob.turn_id is null
  and exists (select 1 from task_turns tt where tt.task_id = ob.task_id);

alter table orchestration_blueprints
  drop constraint if exists orchestration_blueprints_task_id_key;

alter table orchestration_blueprints
  drop constraint if exists orchestration_blueprints_turn_id_key;

alter table orchestration_blueprints
  add constraint orchestration_blueprints_turn_id_key unique (turn_id);

create index if not exists orchestration_blueprints_task_created_idx
  on orchestration_blueprints(task_id, created_at desc);

alter table runtime_sessions
  add column if not exists turn_id uuid references task_turns(id) on delete cascade;

update runtime_sessions rs
set turn_id = (
  select tt.id
  from task_turns tt
  where tt.task_id = rs.task_id
    and tt.created_at <= rs.created_at
  order by tt.created_at desc
  limit 1
)
where rs.turn_id is null
  and exists (
    select 1 from task_turns tt
    where tt.task_id = rs.task_id and tt.created_at <= rs.created_at
  );

create index if not exists runtime_sessions_turn_idx
  on runtime_sessions(turn_id)
  where turn_id is not null;
