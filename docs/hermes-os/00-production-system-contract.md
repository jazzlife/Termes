# 00. Production System Contract

## 목적

Termes를 첨부 Hermes OS 스펙에 맞춰 프로덕션 수준으로 구현하기 위한 불변 계약을 정의한다. 이 문서는 이후 모든 단계의 기준이다.

## 현재 기준

현재 Termes 서비스:

- `apps/api`: Control Plane API, DB, GitHub project registration, SSE events
- `apps/web`: 모바일 PWA 중심 UI
- `services/orchestrator`: task claim, Hermes run 생성, task/checkpoint 반영
- `services/hermes-manager`: Hermes 호환 API, managed runner bridge
- `services/runner-supervisor`: worktree 생성, 검증, artifact 생성
- 신규 예정: `services/device-gateway`

현재 데이터 기준:

- source root: `/Users/jazzlife/Documents/Workspaces/Products/Termes`
- server source root: `/data/docker_data/termes/app`
- durable root: `/data/docker_data/termes`
- workspace root: `/data/docker_data/termes/workspaces`
- run root: `/data/docker_data/termes/runs`
- Hermes state root: `/data/docker_data/termes/hermes`

## 프로덕션 완료 조건

아래가 모두 충족되어야 완료다.

- GitHub login 또는 server token으로 저장소 clone 후 프로젝트 등록 가능
- task 생성 후 orchestrator가 task plan을 만들고 Hermes run을 실행
- runner-supervisor가 worktree, verifier, artifact, checkpoint 생성
- device-gateway가 Android, Tizen, Linux, Windows 계약을 제공
- 외부 장치가 없어도 `local_mock` device command 경로가 완전히 동작
- device command는 DB, event, artifact, verification result에 연결
- 위험 명령은 실행 전 차단 또는 approval로 전환
- 모바일 PWA에서 device 목록, command 실행, 로그/결과 확인 가능
- 배포 후 모든 핵심 컨테이너 healthy
- 모든 테스트 데이터 정리 가능

## 서비스 책임

| 서비스 | 책임 |
| --- | --- |
| `apps/api` | DB 원장, API 계약, events, device command persistence, gateway dispatch |
| `apps/web` | 모바일/태블릿/데스크톱 UI, task/device visibility, approval UI |
| `services/orchestrator` | intent, capability selection, task plan, step execution |
| `services/hermes-manager` | Hermes API 호환, capability registry, run/session/job |
| `services/runner-supervisor` | code/worktree execution, verification artifact |
| `services/device-gateway` | device discovery, command execution, platform adapters |

## 엔진 매핑

| Hermes Engine | 구현 위치 |
| --- | --- |
| Intent Engine | `services/orchestrator` |
| Context Engine | `apps/api` + PostgreSQL + artifacts |
| Competency Engine | `services/hermes-manager` + DB `capability_packages` |
| Knowledge Engine | capability packages + memory records + project files |
| Planning Engine | `services/orchestrator` |
| Strategy Engine | `services/orchestrator` |
| Memory Engine | DB `memory_records`, `artifacts`, `checkpoints` |
| Verification Engine | `runner-supervisor`, `orchestrator`, `verification_results` |
| Tool Runtime | `runner-supervisor` |
| Device Runtime | `device-gateway` |
| Execution Monitor | `orchestrator`, `device_commands`, `events` |
| Learning Engine | 후순위: capability confidence/audit logs |

## 상태 전이 계약

Task:

```text
created -> running -> completed
created -> running -> reviewing -> running -> completed
created -> running -> failed
created -> running -> blocked
created -> cancelled
```

Device command:

```text
created -> queued -> running -> completed
created -> queued -> blocked
created -> queued -> running -> failed
created -> cancelled
```

Task plan:

```text
created -> running -> completed
created -> running -> reviewing
created -> running -> failed
```

## 이벤트 계약

새 이벤트 타입은 문자열로 저장하되 payload 구조를 고정한다.

- `task.plan.created`
- `task.plan.step.started`
- `task.plan.step.completed`
- `task.plan.step.failed`
- `device.command.created`
- `device.command.queued`
- `device.command.running`
- `device.command.completed`
- `device.command.failed`
- `device.command.blocked`
- `verification.created`

payload 공통 필드:

- `taskPlanId`
- `stepId`
- `deviceId`
- `deviceCommandId`
- `status`
- `summary`
- `artifactUri`

## 보안 계약

- 모든 path는 허용 root 내부인지 확인한다.
- device endpoint host는 allowlist를 통과해야 한다.
- secret은 response payload에 나오면 안 된다.
- destructive command는 default deny다.
- service restart, install, uninstall은 approval 후보로 처리한다.
- command stdout/stderr는 크기 제한과 truncation marker를 둔다.
- logs stream은 timeout과 line limit을 둔다.

## 구현 프롬프트

```text
당신은 Termes Hermes OS Production Architect입니다.

먼저 이 문서와 현재 코드의 실제 서비스 구조를 읽으십시오.
위 Production System Contract를 기준으로 이후 단계의 구현 문서, 코드 변경, 테스트가 같은 용어와 상태 전이를 쓰도록 강제하십시오.

작업:
1. 현재 서비스 책임이 문서와 충돌하는지 확인한다.
2. 충돌이 있으면 이 문서를 먼저 수정한다.
3. 신규 구현에서 service name, route, table, event type이 이 문서와 일치하는지 검토한다.

완료 조건:
- 이후 단계 문서가 이 문서의 서비스명, 상태명, 이벤트명을 그대로 사용한다.
- local_mock 경로가 전체 시스템 최소 검증 기준으로 남는다.
```

## 체크리스트

- [ ] 현재 repo의 서비스명이 문서와 일치한다.
- [ ] `/data/docker_data/termes` 기준 경로가 모든 단계 문서에 일관되게 반영됐다.
- [ ] task 상태 전이가 기존 enum과 충돌하지 않는다.
- [ ] device command 상태 전이가 이후 DB 문서에 반영됐다.
- [ ] event type 목록이 API/orchestrator/UI 문서에서 재사용된다.
- [ ] Windows가 platform 계약에 포함됐다.
- [ ] WinRM과 OpenSSH transport가 모두 문서화됐다.
- [ ] 외부 장치 없이 `local_mock`로 완료 검증이 가능하다.
