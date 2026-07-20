# 02. Device Gateway Core

## 목적

`services/device-gateway`를 추가하고 외부 장치 없이도 `local_mock`으로 end-to-end 검증 가능한 gateway core를 구현한다.

## 선행 조건

- `00-production-system-contract.md`
- `01-db-shared-contracts.md`
- 현재 파일 재확인:
  - `package.json`
  - `pnpm-workspace.yaml`
  - `tsconfig.base.json`
  - `services/runner-supervisor/src/main.ts`
  - `infra/compose/docker-compose.yml`
  - `infra/compose/.env.example`

## 산출물

- `services/device-gateway/package.json`
- `services/device-gateway/tsconfig.json`
- `services/device-gateway/Dockerfile`
- `services/device-gateway/src/main.ts`
- compose service `device-gateway`
- `.env.example` device gateway 변수
- gateway local smoke script 또는 curl 예시

## API 계약

Gateway internal API:

- `GET /healthz`
- `GET /devices`
- `POST /devices/discover`
- `POST /devices/:deviceId/command`
- `GET /commands/:commandId`
- `GET /commands/:commandId/logs`

Gateway는 DB에 직접 쓰지 않는다. DB 원장은 `apps/api`가 관리한다. Gateway는 실행 결과 JSON을 반환하고, API가 그 결과를 DB에 반영한다.

## platform/transport 계약

Gateway core는 모든 adapter를 같은 입력/출력 계약으로 실행한다.

| platform | transport |
| --- | --- |
| `local_mock` | `local_mock` |
| `linux` | `ssh` |
| `windows` | `winrm`, `ssh` |
| `android` | `adb` |
| `tizen` | `sdb` |

Windows 계약:

- `winrm` transport는 schema, validation, API 응답에 반드시 존재한다.
- WinRM 실행 라이브러리가 아직 없으면 `transport_unavailable` 실패 결과를 반환한다.
- Windows OpenSSH는 `ssh` transport로 실행 가능한 경로를 제공한다.
- Windows command action은 `windows.*` prefix만 허용한다.

## local_mock action

- `local_mock.health`: gateway 상태 반환
- `local_mock.echo`: params payload를 stdout으로 반환
- `local_mock.fail`: 의도적으로 실패 반환
- `local_mock.sleep`: timeout과 cancellation 검증용

## command result 형식

```json
{
  "id": "command-id",
  "deviceId": "device-id",
  "action": "local_mock.echo",
  "status": "completed",
  "stdout": "text",
  "stderr": "",
  "exitCode": 0,
  "artifactUri": null,
  "startedAt": "ISO",
  "completedAt": "ISO",
  "durationMs": 12
}
```

## 보안/운영 원칙

- Gateway root는 `/data/docker_data/termes/device-gateway`.
- command result는 `<root>/commands/<commandId>.json`에 저장한다.
- stdout/stderr는 최대 길이를 제한한다.
- request body는 zod 또는 명시적 validation으로 검증한다.
- unknown action은 400을 반환한다.
- platform/transport/action prefix가 맞지 않으면 400을 반환한다.
- timeout 초과는 status `failed`와 stderr `timeout`으로 기록한다.

## Compose 계약

`device-gateway` 서비스:

- network: `termes_internal`
- volume: `/data/docker_data/termes/device-gateway:/data/docker_data/termes/device-gateway`
- healthcheck: `GET /healthz`
- env:
  - `PORT=8080`
  - `DEVICE_GATEWAY_ROOT=/data/docker_data/termes/device-gateway`
  - `DEVICE_COMMAND_TIMEOUT_MS=${DEVICE_COMMAND_TIMEOUT_MS:-30000}`
  - `DEVICE_ALLOWED_HOSTS=${DEVICE_ALLOWED_HOSTS:-}`
  - `WINRM_ALLOWED_HOSTS=${WINRM_ALLOWED_HOSTS:-}`

## 구현 프롬프트

```text
당신은 Termes Device Gateway Core Engineer입니다.

00, 01, 02 문서를 읽고 services/device-gateway를 구현하십시오.
현재 services/runner-supervisor와 hermes-manager의 Fastify/Dockerfile 패턴을 먼저 읽고 같은 스타일로 작성하십시오.

작업:
1. device-gateway package, tsconfig, Dockerfile, src/main.ts를 추가한다.
2. local_mock adapter를 구현한다.
3. command result를 DEVICE_GATEWAY_ROOT/commands에 저장한다.
4. GET /healthz, GET /devices, POST /devices/discover, POST /devices/:deviceId/command, GET /commands/:commandId를 구현한다.
5. docker compose에 device-gateway 서비스를 추가한다.
6. .env.example에 필요한 env를 추가한다.
7. package.json에 필요하면 test:devices 준비 항목을 추가한다. smoke 구현은 07 문서에서 완성한다.

검증:
- pnpm lint
- pnpm build
- pnpm compose:config
- 로컬 또는 compose에서 /healthz 확인
- local_mock.echo와 local_mock.fail curl 확인

완료 후:
- compose 변경이 07 문서의 배포 기준과 충돌하지 않는지 확인한다.
```

## 체크리스트

- [ ] `services/device-gateway`가 workspace에 포함됐다.
- [ ] `pnpm lint`가 통과한다.
- [ ] `pnpm build`가 통과한다.
- [ ] `pnpm compose:config`가 통과한다.
- [ ] `GET /healthz`가 service/version/status를 반환한다.
- [ ] `POST /devices/discover`가 최소 local_mock device를 반환한다.
- [ ] platform/transport validation에 `windows`와 `winrm`이 포함됐다.
- [ ] Windows OpenSSH transport 계약이 있다.
- [ ] `local_mock.echo`가 completed result를 반환한다.
- [ ] `local_mock.fail`이 failed result를 반환한다.
- [ ] command result file이 gateway root 아래 저장된다.
- [ ] stdout/stderr 길이 제한이 있다.
- [ ] unknown action은 400이다.
