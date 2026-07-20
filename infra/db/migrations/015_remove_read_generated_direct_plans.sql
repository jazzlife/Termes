delete from task_plans tp
where exists (
  select 1
  from lateral (
    select rd.route
    from task_turns tt
    join route_decisions rd on rd.turn_id = tt.id
    where tt.task_id = tp.task_id
    order by tt.created_at desc
    limit 1
  ) latest
  where latest.route in ('system-control', 'instant', 'direct', 'clarification')
)
and not exists (
  select 1
  from orchestration_blueprints ob
  join specialist_assignments sa on sa.blueprint_id = ob.id
  where ob.task_id = tp.task_id
);
