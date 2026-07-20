# 05. Orchestrator, Capability, Verification

## 목적

Task를 단순 Hermes run으로 보내는 현재 흐름을 intent, capability, task plan, step execution, verification이 있는 프로덕션 흐름으로 확장한다.

## 선행 조건

- `00-production-system-contract.md`
- `01-db-shared-contracts.md`
- `04-control-plane-api.md`
- 현재 파일 재확인:
  - `services/orchestrator/src/main.ts`
  - `services/hermes-manager/src/main.ts`
  - `services/runner-supervisor/src/main.ts`
  - `apps/api/src/server.ts`

## Capability seed

초기 capability:

- `github-project-bootstrap`
- `runner-worktree-verification`
- `web-pwa-verification`
- `linux-ssh-ops`
- `windows-powershell-ops`
- `android-adb-debug`
- `tizen-sdb-debug`

각 package는 DB `capability_packages`에 저장한다.

필수 필드:

- `knowledge`
- `skills`
- `constraints`
- `strategy`
- `execution_pattern`
- `evaluation`

## Intent extraction

MVP는 deterministic matcher로 시작한다.

Mapping examples:

- `windows`, `윈도우`, `PowerShell`, `eventlog`, `서비스` -> `windows-powershell-ops`
- `android`, `apk`, `logcat`, `adb` -> `android-adb-debug`
- `tizen`, `sdb`, `dlog`, `tpk` -> `tizen-sdb-debug`
- `linux`, `ssh`, `journalctl`, `systemctl` -> `linux-ssh-ops`
- `ui`, `mobile`, `pwa`, `화면` -> `web-pwa-verification`

## Task plan step types

- `hermes.run`
- `runner.run`
- `device.command`
- `approval.required`
- `verification.check`

Step schema:

```json
{
  "id": "step-1",
  "type": "device.command",
  "status": "created",
  "capability": "windows-powershell-ops",
  "action": "windows.eventlog.query",
  "params": {},
  "requiresApproval": false,
  "resultRef": null
}
```

## Execution flow

```text
claim task
 -> create runtime profile/session/agent run
 -> extract intent
 -> select capabilities
 -> create task_plans row
 -> execute plan steps
 -> run Hermes for code/task reasoning
 -> dispatch device.command through apps/api
 -> create verification_results
 -> create checkpoint/artifact
 -> complete task
```

## Verification contract

Verification status:

- `passed`
- `failed`
- `inconclusive`

Confidence:

- `>= 0.9`: explicit test or command check passed
- `>= 0.6`: command exit 0 but weak domain verification
- `< 0.6`: human review required
- `0`: failed command or failed test

Low confidence behavior:

- If task has deliverable but weak verification: `reviewing`
- If device unreachable or missing credentials: `blocked`
- If command/test failed: `failed`

## 구현 프롬프트

```text
당신은 Termes Orchestrator and Verification Engineer입니다.

00~04 문서를 읽고 orchestrator에 task plan 기반 실행을 구현하십시오.
현재 services/orchestrator/src/main.ts의 claim/complete/fail 흐름을 다시 읽으십시오.

작업:
1. capability seed를 추가한다.
2. task intent matcher를 구현한다.
3. task_plans row 생성 로직을 추가한다.
4. plan step execution을 추가한다.
5. 기존 Hermes run 경로는 유지하되 plan step으로 감싼다.
6. device.command step은 apps/api 내부 API 또는 직접 DB/gateway dispatch 정책 중 하나로 일관되게 구현한다.
7. verification_results 생성 로직을 추가한다.
8. low confidence 상태 전이를 구현한다.
9. events에 task plan step 진행 상태를 기록한다.

검증:
- 기존 일반 task가 completed 된다.
- local_mock device 관련 task가 device.command step을 만든다.
- Windows 키워드 task가 windows-powershell-ops capability를 선택한다.
- low confidence case가 reviewing 또는 blocked로 간다.
- pnpm lint

완료 후:
- 06 UI 문서에서 task plan을 표시할 수 있도록 API shape를 확인한다.
```

## 체크리스트

- [ ] capability seed가 있다.
- [ ] Windows matcher가 있다.
- [ ] Android matcher가 있다.
- [ ] Tizen matcher가 있다.
- [ ] Linux matcher가 있다.
- [ ] task_plans row가 생성된다.
- [ ] plan step status가 갱신된다.
- [ ] 기존 Hermes run path가 깨지지 않는다.
- [ ] device.command step이 gateway/API로 실행된다.
- [ ] verification_results가 생성된다.
- [ ] confidence 기준이 적용된다.
- [ ] checkpoint에 verification summary가 포함된다.
- [ ] `pnpm lint`가 통과했다.
