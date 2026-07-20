-- Single-account stabilization phase: every existing project belongs to the
-- seeded Master account. Multi-account Account Cells replace this invariant
-- only after the single-account Hermes E2E gate is complete.
insert into project_members (project_id, user_id, role)
select p.id, '00000000-0000-0000-0000-000000000001'::uuid, 'owner'
from projects p
on conflict (project_id, user_id) do nothing;
