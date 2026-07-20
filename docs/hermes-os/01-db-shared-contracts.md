# 01. DB and Shared Contracts

## 목적

Device gateway, capability, task plan, memory, verification을 PostgreSQL 원장과 TypeScript shared 계약으로 추가한다.

## 선행 조건

- `00-production-system-contract.md`를 읽고 상태명과 이벤트명을 확인한다.
- 현재 파일을 다시 읽는다.
  - `infra/db/migrations/001_initial.sql`
  - `infra/db/migrations/002_chat_messages.sql`
  - `packages/shared/src/index.ts`
  - `apps/api/src/server.ts`

## 산출물

  - `infra/db/migrations/003_devices_capabilities_plans.sql`
- `packages/shared/src/index.ts` 타입 확장
- schema seed 또는 capability seed 구조
- migration 검증 로그

## DB 계약

### devices

```sql
create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  key text not null,
  name text not null,
  platform text not null check (platform in ('android', 'tizen', 'linux', 'windows', 'local_mock')),
  transport text not null check (transport in ('adb', 'sdb', 'ssh', 'winrm', 'local_mock')),
  endpoint text,
  labels jsonb not null default '{}'::jsonb,
  status text not null default 'unknown' check (status in ('unknown', 'offline', 'online', 'busy', 'error')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, key)
);
```

### device_sessions

필드:

- `id uuid primary key`
- `device_id uuid not null references devices(id) on delete cascade`
- `lease_owner text not null`
- `status text`: `created`, `active`, `expired`, `closed`, `error`
- `metadata jsonb`
- `started_at`, `expires_at`, `closed_at`, `created_at`, `updated_at`

### device_commands

필드:

- `id uuid primary key`
- `project_id uuid references projects`
- `task_id uuid references tasks`
- `device_id uuid references devices`
- `action text not null`
- `params jsonb not null`
- `status text`: `created`, `queued`, `running`, `completed`, `failed`, `cancelled`, `blocked`
- `approval_id uuid references approvals`
- `stdout text not null default ''`
- `stderr text not null default ''`
- `exit_code integer`
- `artifact_uri text`
- `started_at`, `completed_at`, `created_at`, `updated_at`

### capability_packages

필드:

- `id uuid primary key`
- `key text unique not null`
- `title text not null`
- `platform text nullable`
- `knowledge jsonb not null`
- `skills jsonb not null`
- `constraints jsonb not null`
- `strategy jsonb not null`
- `execution_pattern jsonb not null`
- `evaluation jsonb not null`
- `confidence numeric not null default 0`
- `enabled boolean not null default true`
- `created_at`, `updated_at`

### task_plans

필드:

- `id uuid primary key`
- `task_id uuid not null references tasks(id) on delete cascade`
- `intent jsonb not null`
- `capability_keys jsonb not null`
- `steps jsonb not null`
- `status text`: `created`, `running`, `reviewing`, `completed`, `failed`, `cancelled`
- `created_at`, `updated_at`

### memory_records

필드:

- `id uuid primary key`
- `project_id uuid references projects`
- `task_id uuid references tasks`
- `device_id uuid references devices`
- `scope text not null`
- `key text not null`
- `value jsonb not null`
- `source text not null`
- `created_at`

### verification_results

필드:

- `id uuid primary key`
- `task_id uuid references tasks`
- `device_command_id uuid references device_commands`
- `status text`: `passed`, `failed`, `inconclusive`
- `confidence numeric not null`
- `checks jsonb not null`
- `summary text not null`
- `created_at`

## Index 계약

필수 index:

- `devices_project_platform_idx`
- `devices_key_idx`
- `device_commands_task_created_idx`
- `device_commands_device_created_idx`
- `task_plans_task_idx`
- `memory_records_project_scope_idx`
- `verification_results_task_idx`

## Shared 타입 계약

`packages/shared/src/index.ts`에 추가:

```ts
export type DevicePlatform = "android" | "tizen" | "linux" | "windows" | "local_mock";
export type DeviceTransport = "adb" | "sdb" | "ssh" | "winrm" | "local_mock";
export type DeviceStatus = "unknown" | "offline" | "online" | "busy" | "error";
export type DeviceCommandStatus = "created" | "queued" | "running" | "completed" | "failed" | "cancelled" | "blocked";
export type VerificationStatus = "passed" | "failed" | "warning" | "unknown";
```

필수 interface:

- `DeviceSummary`
- `DeviceCommandSummary`
- `CapabilityPackageSummary`
- `TaskPlanSummary`
- `VerificationResultSummary`

## 구현 프롬프트

```text
당신은 Termes DB/API Contract Engineer입니다.

00-production-system-contract.md와 이 문서를 읽고 DB migration과 shared 타입을 구현하십시오.
현재 migration과 shared index를 다시 읽은 뒤 변경하십시오.

작업:
1. infra/db/migrations/003_devices_capabilities_plans.sql을 추가한다.
2. 모든 create table은 if not exists로 작성한다.
3. check constraint는 문서의 상태명과 정확히 일치시킨다.
4. index를 추가한다.
5. packages/shared/src/index.ts에 device/capability/plan/verification 타입을 추가한다.
6. 기존 타입 export를 깨뜨리지 않는다.

검증:
- pnpm lint
- pnpm compose:config
- 가능하면 migrate 서비스를 통해 SQL 적용을 확인한다.

완료 후:
- 이 문서 체크리스트를 기준으로 누락을 점검한다.
- 구현 중 상태명/필드명이 바뀌었다면 00 문서와 이 문서를 함께 수정한다.
```

## 체크리스트

- [ ] `003_devices_capabilities_plans.sql`이 추가됐다.
- [ ] migration은 idempotent하다.
- [ ] `devices.platform`에 `windows`가 포함됐다.
- [ ] `devices.platform`에 `local_mock`이 포함됐다.
- [ ] `devices.transport`에 `winrm`과 `local_mock`이 포함됐다.
- [ ] `device_commands.status`가 00 문서와 일치한다.
- [ ] `task_plans.status`가 00 문서와 일치한다.
- [ ] `verification_results.status`가 00 문서와 일치한다.
- [ ] 필수 index가 생성됐다.
- [ ] shared 타입이 web/api/services에서 import 가능하다.
- [ ] `pnpm lint`가 통과했다.
- [ ] `pnpm compose:config`가 통과했다.
