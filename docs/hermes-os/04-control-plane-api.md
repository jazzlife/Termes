# 04. Control Plane API

## 목적

`apps/api`가 device, capability, task plan, verification 원장을 관리하고 `device-gateway`를 내부 서비스로 dispatch하도록 구현한다.

## 선행 조건

- `01-db-shared-contracts.md`
- `02-device-gateway-core.md`
- `03-platform-adapters.md`
- 현재 파일 재확인:
  - `apps/api/src/server.ts`
  - `apps/api/src/events.ts`
  - `apps/api/src/db.ts`
  - `packages/shared/src/index.ts`
  - `apps/web/src/api.ts`

## API 계약

Devices:

- `GET /api/devices`
- `POST /api/devices`
- `PATCH /api/devices/:deviceId`
- `DELETE /api/devices/:deviceId`
- `POST /api/devices/discover`

Commands:

- `POST /api/devices/:deviceId/commands`
- `GET /api/device-commands/:commandId`
- `GET /api/device-commands/:commandId/logs`

Device create/update validation:

- `platform`: `android`, `tizen`, `linux`, `windows`, `local_mock`
- `transport`: `adb`, `sdb`, `ssh`, `winrm`, `local_mock`
- `windows`는 `winrm` 또는 `ssh`만 허용한다.
- `linux`는 `ssh`만 허용한다.
- `android`는 `adb`만 허용한다.
- `tizen`은 `sdb`만 허용한다.
- `local_mock` platform은 `local_mock` transport만 허용하고 외부 장치 없는 smoke와 UI 검증용으로 항상 제공한다.

Capabilities:

- `GET /api/capabilities`
- `POST /api/capabilities`
- `PATCH /api/capabilities/:capabilityId`

Plans:

- `GET /api/tasks/:taskId/plan`
- `GET /api/tasks/:taskId/verification-results`

## Dispatch flow

```text
POST /api/devices/:deviceId/commands
 -> validate request
 -> load device
 -> policy check
 -> create device_commands row status=created
 -> if requires approval: create approvals row, status=blocked, emit event
 -> else status=queued, emit event
 -> call device-gateway internal API
 -> status=running/completed/failed
 -> persist stdout/stderr/exitCode/artifactUri
 -> create verification_results
 -> emit event
 -> return DeviceCommandSummary
```

## Policy contract

`apps/api`가 최종 실행 승인자다. Gateway도 방어하지만 API에서 먼저 막는다.

Approval required examples:

- `linux.service.restart`
- `windows.service.restart`
- `windows.app.install.*`
- `windows.app.uninstall`
- `android.install`
- `android.uninstall`
- `tizen.install`
- `tizen.uninstall`

Blocked examples:

- root filesystem deletion
- disk formatting
- shutdown/reboot
- Windows destructive PowerShell
- Windows WinRM credential 또는 endpoint 값을 event payload/stdout/stderr에 남기는 동작

## Event contract

Command 생성/진행/완료마다 `appendEvent`를 호출한다.

Payload:

```json
{
  "deviceId": "uuid",
  "deviceCommandId": "uuid",
  "action": "windows.eventlog.query",
  "status": "completed",
  "summary": "50 events collected"
}
```

## Web API client

`apps/web/src/api.ts`에 추가:

- `fetchDevices`
- `discoverDevices`
- `createDevice`
- `updateDevice`
- `deleteDevice`
- `runDeviceCommand`
- `fetchDeviceCommand`
- `fetchDeviceCommandLogs`
- `fetchCapabilities`
- `fetchTaskPlan`
- `fetchVerificationResults`

## 구현 프롬프트

```text
당신은 Termes Control Plane API Engineer입니다.

01~03 문서를 읽고 apps/api에 device/capability/task-plan API를 구현하십시오.
현재 apps/api/src/server.ts와 events.ts를 다시 읽고 기존 Fastify 스타일을 유지하십시오.

작업:
1. zod schema를 추가한다.
2. devices CRUD API를 추가한다.
3. platform/transport validation을 추가한다. Windows는 winrm과 ssh를 허용한다.
4. device discovery API를 추가한다.
5. device command dispatch API를 추가한다.
6. capability API를 추가한다.
7. task plan/verification 조회 API를 추가한다.
8. device command event emit을 추가한다.
9. apps/web/src/api.ts client 함수를 추가한다.

검증:
- pnpm lint
- curl로 local_mock device 등록
- curl로 local_mock.echo command 실행
- command row와 event row가 생성됐는지 확인

완료 후:
- API route 이름이 06 UI 문서와 일치하는지 확인한다.
```

## 체크리스트

- [ ] devices CRUD가 있다.
- [ ] Windows device는 `winrm`과 `ssh` transport를 허용한다.
- [ ] platform/transport 불일치는 400을 반환한다.
- [ ] discover API가 있다.
- [ ] command dispatch가 DB에 기록된다.
- [ ] approval required action은 gateway로 바로 가지 않는다.
- [ ] blocked action은 실행되지 않는다.
- [ ] completed command는 stdout/stderr/exitCode를 저장한다.
- [ ] failed command는 stderr를 저장한다.
- [ ] verification_results가 생성된다.
- [ ] events가 publish된다.
- [ ] web API client가 추가됐다.
- [ ] `pnpm lint`가 통과했다.
