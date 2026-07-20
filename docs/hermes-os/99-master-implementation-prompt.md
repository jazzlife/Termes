# 99. Master Implementation Prompt

이 문서는 00~07 문서를 실제 구현으로 실행하기 위한 최종 프롬프트입니다.

## Master Prompt

```text
당신은 Termes Hermes OS Production Implementer입니다.

목표:
현재 Termes 프로젝트를 Hermes OS 사양에 맞춰 실제 동작하는 프로덕션 수준 MVP로 구현한다.

반드시 읽을 문서:
1. docs/hermes-os/00-production-system-contract.md
2. docs/hermes-os/01-db-shared-contracts.md
3. docs/hermes-os/02-device-gateway-core.md
4. docs/hermes-os/03-platform-adapters.md
5. docs/hermes-os/04-control-plane-api.md
6. docs/hermes-os/05-orchestrator-capability-verification.md
7. docs/hermes-os/06-mobile-pwa-ui.md
8. docs/hermes-os/07-deployment-smoke-release.md

작업 원칙:
1. 각 단계 시작 전 현재 코드를 다시 읽는다.
2. 문서와 코드가 충돌하면 코드를 근거로 문서를 수정한 뒤 구현한다.
3. 이후 단계에서 이전 단계 문제를 발견하면 이전 문서를 수정한다.
4. 구현은 local_mock 경로를 먼저 완성해 외부 장치 없이 E2E 검증 가능하게 한다.
5. Android, Tizen, Linux, Windows 계약을 모두 유지한다.
6. Windows는 WinRM 계약과 OpenSSH 실행 경로를 모두 문서/타입/API/UI에 반영한다.
7. 모든 device command는 DB, event, verification result에 남긴다.
8. 위험 명령은 실행하지 않는다. 차단하거나 approval로 전환한다.
9. 모바일 PWA에서 실제 조작 가능한 UI를 만든다.
10. 모든 소스와 볼륨 경로는 /data/docker_data/termes 기준을 지킨다.

실행 순서:
1. 01 DB and Shared Contracts 구현
2. 02 Device Gateway Core 구현
3. 03 Platform Adapters 구현
4. 04 Control Plane API 구현
5. 05 Orchestrator, Capability, Verification 구현
6. 06 Mobile PWA UI 구현
7. 07 Deployment, Smoke, Release 구현

각 단계 완료 조건:
- 해당 문서 체크리스트를 모두 만족한다.
- pnpm lint를 실행한다.
- 단계별 smoke를 실행한다.
- 실패하면 다음 단계로 넘어가지 않는다.

최종 검증:
- pnpm lint
- pnpm build
- pnpm test
- pnpm compose:config
- pnpm test:hermes
- pnpm test:devices
- 서버 /data/docker_data/termes/app 배포
- docker compose ps health 확인
- 모바일 390x844 Playwright UI 검증
- 테스트 데이터 정리

최종 보고:
- 구현된 파일 목록
- DB migration 결과
- API route 목록
- device-gateway 지원 platform/action 목록
- 검증 명령과 결과
- 서버 배포 URL
- 남은 외부 장치 의존 항목
```

## Cross-Document Consistency Checklist

- [ ] 모든 문서가 같은 서비스명을 사용한다.
- [ ] 모든 문서가 `/data/docker_data/termes` 기준 경로를 사용한다.
- [ ] DB 상태명과 shared 타입 상태명이 일치한다.
- [ ] API route와 web API client 함수명이 일치한다.
- [ ] device-gateway route와 API dispatch 계약이 일치한다.
- [ ] Windows platform이 DB, shared, gateway, API, UI, smoke 문서에 모두 있다.
- [ ] WinRM transport가 DB, shared, gateway, UI 문서에 있다.
- [ ] OpenSSH Windows MVP 경로가 platform adapter와 smoke 문서에 있다.
- [ ] local_mock이 gateway, API, UI, smoke 문서에 있다.
- [ ] approval required action이 API, orchestrator, UI 문서에 일관되게 있다.
- [ ] verification_results가 DB, API, orchestrator, UI 문서에 있다.
- [ ] 최종 검증 명령이 README/문서/package script와 일치한다.
- [ ] secret params redaction과 endpoint allowlist 정책이 gateway/API/smoke 문서에 일관되게 있다.

## Production Completion Checklist

- [ ] `services/device-gateway` 구현 완료
- [ ] DB migration 적용 완료
- [ ] shared 타입 적용 완료
- [ ] API device/capability/plan route 구현 완료
- [ ] orchestrator plan flow 구현 완료
- [ ] capability matcher 구현 완료
- [ ] verification result flow 구현 완료
- [ ] mobile Devices UI 구현 완료
- [ ] smoke test 구현 완료
- [ ] compose 배포 구현 완료
- [ ] 서버 배포 검증 완료
- [ ] 테스트 데이터 정리 완료
