insert into capability_packages (key, name, description, platforms, actions, enabled)
values (
  'desktop-app-debug',
  'Desktop App Debug',
  'Transfer bounded project source files to an Account-owned Desktop Connector, run a locally approved Node.js app, and return stdout, stderr, and exit status to the invoking Task.',
  '["windows", "macos"]'::jsonb,
  '["windows.dev.app.run", "macos.dev.app.run"]'::jsonb,
  true
)
on conflict (key) do update
set name = excluded.name,
    description = excluded.description,
    platforms = excluded.platforms,
    actions = excluded.actions,
    enabled = excluded.enabled,
    updated_at = now();

update capability_packages
set actions = actions || '["windows.dev.app.run"]'::jsonb,
    updated_at = now()
where key = 'windows-desktop-connector'
  and not actions @> '["windows.dev.app.run"]'::jsonb;

update capability_packages
set actions = actions || '["macos.dev.app.run"]'::jsonb,
    updated_at = now()
where key = 'macos-desktop-connector'
  and not actions @> '["macos.dev.app.run"]'::jsonb;
