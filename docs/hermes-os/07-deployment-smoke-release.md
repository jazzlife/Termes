# 07. Deployment, Smoke, Release

## 목적

구현된 Hermes OS 기능을 로컬과 서버에서 검증하고, `/data/docker_data/termes/app` 기준으로 배포 가능한 상태를 만든다.

## 선행 조건

- `01`~`06` 문서 체크리스트 완료
- 현재 파일 재확인:
  - `package.json`
  - `scripts/hermes-smoke.mjs`
  - `infra/compose/docker-compose.yml`
  - `infra/compose/.env.example`
  - `README.md`

## 필수 scripts

`package.json`:

- `test:devices`: `node scripts/device-gateway-smoke.mjs`
- 기존 `test:hermes` 유지
- 기존 `compose:config` 유지

## device smoke

`scripts/device-gateway-smoke.mjs`는 다음을 검증한다.

1. Web/API base URL 결정
2. `/api/devices` 응답
3. 임시 프로젝트 생성
4. local_mock device 생성 또는 발견
5. device update/delete API가 실제로 반영되고 삭제 후 목록에서 제거되는지 확인
6. `local_mock.echo` command 실행
7. secret params redaction이 DB command ledger와 command stdout에 적용되는지 확인
8. dangerous command blocked + warning verification 확인
9. command completed 조회
10. capability list 조회
11. task 생성 후 orchestrator가 `local_mock` device.command step을 실행하고 `deviceCommandId`, passed verification, event ledger를 남기는지 확인
12. Windows WinRM contract `transport_unavailable` 확인
13. 임시 프로젝트와 workspace 정리 확인

선택 env:

- `TERMES_BASE_URL`
- `DEVICE_SMOKE_SSH_ENDPOINT`
- `DEVICE_SMOKE_WINDOWS_ENDPOINT`
- `DEVICE_SMOKE_WINDOWS_TRANSPORT=winrm|ssh`
- `DEVICE_SMOKE_ANDROID_SERIAL`
- `DEVICE_SMOKE_TIZEN_SERIAL`

외부 장치 env가 없어도 local_mock과 Windows WinRM contract smoke는 검증한다.

Platform smoke 확장:

- Linux env가 있으면 `linux.system.info`를 실행한다.
- Windows env가 있으면 `DEVICE_SMOKE_WINDOWS_TRANSPORT`에 따라 추가 `windows.system.info`를 실행한다.
- 기본 Windows WinRM contract smoke는 WinRM bridge 미구성 상태에서 명확한 `transport_unavailable` 결과를 검증한다.
- Windows `ssh` transport가 설정되어 있으면 OpenSSH 실행 경로로 `windows.system.info` completed를 검증한다.
- Android serial이 있으면 `android.system.info`를 실행한다.
- Tizen serial이 있으면 `tizen.system.info`를 실행한다.

## Compose 검증

필수 서비스:

- postgres
- redis
- minio
- migrate
- api
- orchestrator
- hermes-manager
- runner-supervisor
- device-gateway
- web

명령:

```bash
pnpm lint
pnpm build
pnpm test
pnpm compose:config
pnpm test:hermes
pnpm test:devices
```

## 서버 배포 절차

```bash
cd /data/docker_data/termes/app
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml up -d --build
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml ps
```

주의:

- 서버 `.env`는 덮어쓰지 않는다.
- secrets는 문서나 로그에 출력하지 않는다.
- 테스트 데이터는 정리한다.

## 최종 E2E

서버에서 확인:

- `curl http://100.64.0.9:4180/api/devices`
- local_mock command 실행
- Windows transport 등록 UI에서 WinRM/OpenSSH 선택지 확인
- task 생성 후 completed/checkpoint 확인
- task plan의 `local-mock-device` step이 completed이고 `deviceCommandId`에 연결됐는지 확인
- task runtime events에 `device.command.completed`, `task.plan.step.completed`, `verification.created`가 남는지 확인
- 모바일 PWA 390x844에서 Devices UI 확인

## 구현 프롬프트

```text
당신은 Termes Release and QA Engineer입니다.

01~06 문서를 읽고 smoke와 배포 검증을 완성하십시오.
현재 package.json, scripts, compose, README를 다시 읽고 변경하십시오.

작업:
1. scripts/device-gateway-smoke.mjs를 추가한다.
2. package.json에 test:devices를 추가한다.
3. README에 device gateway 실행과 smoke 방법을 추가한다.
4. compose health와 env를 점검한다.
5. 로컬 검증 명령을 모두 실행한다.
6. 서버에 배포하고 health를 확인한다.
7. 모바일 PWA에서 command 실행까지 검증한다.
8. 테스트 데이터와 임시 command를 정리한다.

완료 기준:
- pnpm lint 통과
- pnpm build 통과
- pnpm test 통과
- pnpm compose:config 통과
- pnpm test:hermes 통과
- pnpm test:devices 통과
- 서버 핵심 컨테이너 healthy
- 모바일 command 실행 확인
```

## 체크리스트

- [ ] `scripts/device-gateway-smoke.mjs`가 있다.
- [ ] `package.json`에 `test:devices`가 있다.
- [ ] local_mock smoke가 외부 장치 없이 통과한다.
- [ ] Windows WinRM contract smoke가 외부 장치 없이 `transport_unavailable`을 검증한다.
- [ ] secret params가 command ledger와 stdout/stderr에서 redaction 된다.
- [ ] dangerous command가 blocked 되고 warning verification이 생성된다.
- [ ] optional platform smoke가 env 기반으로만 실행된다.
- [ ] Windows smoke env는 WinRM과 OpenSSH transport를 구분한다.
- [ ] WinRM 미구성 시 `transport_unavailable` 결과를 검증한다.
- [ ] README에 device gateway 운영 방법이 있다.
- [ ] compose에 device-gateway healthcheck가 있다.
- [ ] `pnpm lint`가 통과했다.
- [ ] `pnpm build`가 통과했다.
- [ ] `pnpm test`가 통과했다.
- [ ] `pnpm compose:config`가 통과했다.
- [ ] `pnpm test:hermes`가 통과했다.
- [ ] `pnpm test:devices`가 통과했다.
- [ ] 서버 배포 후 all healthy다.
- [ ] 모바일 UI 검증이 완료됐다.
- [ ] 테스트 데이터가 정리됐다.
