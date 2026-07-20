# Hermes OS Production Implementation Prompts

이 파일은 Hermes OS를 Termes에 프로덕션 수준으로 구현하기 위한 문서 세트의 진입점입니다.

구현자는 아래 문서를 순서대로 읽고 실행해야 합니다. 각 문서에는 실제 구현 프롬프트와 완료 체크리스트가 포함되어 있습니다.

1. [00 Production System Contract](docs/hermes-os/00-production-system-contract.md)
2. [01 DB and Shared Contracts](docs/hermes-os/01-db-shared-contracts.md)
3. [02 Device Gateway Core](docs/hermes-os/02-device-gateway-core.md)
4. [03 Platform Adapters](docs/hermes-os/03-platform-adapters.md)
5. [04 Control Plane API](docs/hermes-os/04-control-plane-api.md)
6. [05 Orchestrator Capability Verification](docs/hermes-os/05-orchestrator-capability-verification.md)
7. [06 Mobile PWA UI](docs/hermes-os/06-mobile-pwa-ui.md)
8. [07 Deployment Smoke Release](docs/hermes-os/07-deployment-smoke-release.md)
9. [99 Master Implementation Prompt](docs/hermes-os/99-master-implementation-prompt.md)

공통 원칙:

- 현재 코드를 먼저 읽고 구현한다.
- 이전 단계 문서와 산출물이 이후 구현과 충돌하면 이전 문서를 수정한다.
- 각 단계 체크리스트는 다음 단계 진입 조건이다.
- 외부 장치가 없어도 `local_mock` 경로는 반드시 동작해야 한다.
- Android, Tizen, Linux, Windows는 모두 최종 계약에 포함한다.
- Windows는 WinRM을 계약에 포함하고, MVP 동작 경로는 OpenSSH 또는 mock으로 검증 가능해야 한다.
- 모든 소스와 볼륨 데이터는 `/data/docker_data/termes` 아래를 기준으로 한다.

바로 실행할 프롬프트:

```text
docs/hermes-os/99-master-implementation-prompt.md를 읽고, 00~07단계 문서의 체크리스트를 기준으로 Termes Hermes OS를 실제 동작하는 수준까지 구현해.
각 단계 시작 전 현재 코드를 다시 읽고, 구현 중 발견한 충돌은 해당 단계 문서와 이전 단계 문서에 반영해.
각 단계 완료 시 pnpm lint/build/test와 해당 smoke를 실행하고, 실패하면 다음 단계로 넘어가지 마.
```
