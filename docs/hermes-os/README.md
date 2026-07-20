# Hermes OS Production Documents

이 디렉터리는 Termes를 Hermes OS 사양에 맞춰 실제 동작 가능한 프로덕션 시스템으로 구현하기 위한 단계별 문서입니다.

문서 작성 기준:

- 계획이 아니라 구현 가능한 작업 단위로 쓴다.
- 각 문서는 이전 단계의 산출물을 입력으로 삼는다.
- 각 문서는 구현 프롬프트와 체크리스트를 포함한다.
- 이후 단계에서 이전 단계의 문제를 발견하면 이전 문서를 수정한다.
- 최종 문서 세트는 모순 없이 같은 API, DB, 서비스명, 검증 명령을 사용해야 한다.

실행 순서:

1. `00-production-system-contract.md`
2. `01-db-shared-contracts.md`
3. `02-device-gateway-core.md`
4. `03-platform-adapters.md`
5. `04-control-plane-api.md`
6. `05-orchestrator-capability-verification.md`
7. `06-mobile-pwa-ui.md`
8. `07-deployment-smoke-release.md`
9. `99-master-implementation-prompt.md`

완료 판정:

- 로컬 검증: `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm test:hermes`, `pnpm test:devices`
- Compose 검증: `pnpm compose:config`
- 서버 검증: `/data/docker_data/termes/app`에서 compose 재빌드 후 모든 핵심 컨테이너 healthy
- UI 검증: 모바일 390x844 viewport에서 device 등록, command 실행, task plan/verification 확인
