# Hermes × Termes 기능 지원 정본

## 판정 기준

기준 upstream은 `realfishsam/hermes-agent@7fb875451bcef8c379ece6779c6b147eef42c05d`다. 목록은 `artifacts/hermes-parity/methods.json`, `events.json`, `routes.json`에서 생성하며 숫자를 수동으로 늘리거나 추정하지 않는다.

각 기능은 다음 상태 중 하나로만 표시한다.

| 상태 | 의미 |
| --- | --- |
| `exact_transport` | Termes relay가 upstream JSON-RPC method, ID, result/error, event frame을 변경하지 않고 전달 |
| `adapted_with_test` | Termes Project/Task UX에 결합했지만 upstream 의미와 동등성 test가 존재 |
| `policy_blocked` | 공유 OpenAI 계정 또는 OAuth-only 정책상 의도적으로 호출 차단 |
| `operator_only` | exact transport로 호출 가능하지만 전용 일반 사용자 화면은 아직 없음 |
| `not_yet_ui` | Dedicated Desktop/Mobile UI와 E2E가 아직 없음 |

`exact_transport`는 전용 화면 완성을 뜻하지 않는다. Protocol parity와 Product UI parity를 분리해서 집계한다.

## 현재 집계 — 2026-07-12

| 항목 | 코드 추출 수 | 현재 판정 |
| --- | ---: | --- |
| JSON-RPC method | 123 | 119 `exact_transport`, 4 `policy_blocked` |
| 명시 event | 20 | 20 reducer/relay 보존 |
| 확장 event | open union | unknown event 보존·mirror·projection 회귀 test 통과 |
| Desktop static route | 9 + session | transport 접근 가능, dedicated Termes UI는 아래 표 기준 |
| upstream performance scenario | 8 | manifest 고정, 동일 환경 A/A 측정은 release gate 미완료 |

### 정책 차단 4개

- `model.save_key`: API key 저장은 OAuth-only 원칙과 충돌
- `billing.auto_reload`
- `billing.charge`
- `billing.step_up`

차단은 upstream으로 전달하지 않고 JSON-RPC error `-32001`을 반환한다. 조회 method인 `billing.state`, `billing.charge_status`, `credits.view`는 transport를 유지한다.

## 기능군별 Product UI 상태

| 기능군 | upstream method/route 근거 | Termes 현재 경로 | 상태 |
| --- | --- | --- | --- |
| Session/Conversation | `session.*`, `prompt.*`, `new`, dynamic session | Task 생성·후속 질문 → Orchestrator exact RPC; reconnect/resume ledger | `adapted_with_test` |
| Rich message stream | 20 events + unknown | text/reasoning/tool/interaction reducer, 33ms delta flush, durable projection | `adapted_with_test` |
| Clarify/Approval/Sudo/Secret | `*.respond`, request events | 발생 turn의 inline card, task-derived Account Cell control socket | `adapted_with_test` |
| Specialist/Subagent | `delegation.*`, `subagent.interrupt`, subagent events | 경중·도메인 분류, 최대 3명 `delegate_task`, evidence/review barrier | `adapted_with_test` |
| Project/Workspace | `projects.*`, `project.facts`, `projects`, session route | Termes Project First, account workspace ownership, folder/GitHub 등록 | `adapted_with_test` |
| File/Image/PDF | `file.attach`, `image.*`, `pdf.attach`, `clipboard.paste`, `input.detect_drop` | account-scoped Raw Operator에서 exact 호출 가능; 전용 composer picker는 미구현 | `operator_only` |
| Process/Terminal/Shell | `process.*`, `terminal.*`, `shell.exec`, `cli.exec` | Task Activity/Terminal 결과 표시, raw exact transport | `operator_only` |
| Rollback/Diff | `rollback.*` | checkpoint/diff 화면 + account-scoped Raw Operator exact 호출 | `operator_only` |
| Skills/Tools/Toolsets | `skills.*`, `tools.*`, `toolsets.list`, skills route | catalog/설정 화면과 Orchestrator toolset 선택 | `adapted_with_test` |
| Plugins | `plugins.*`, plugins catalog | exact transport 및 Manager catalog | `operator_only` |
| Cron/Background/Jobs | `cron.manage`, `prompt.background`, cron route | Manager compatibility jobs UI | `operator_only` |
| Messaging | messaging route | 전용 Termes mobile route 없음 | `not_yet_ui` |
| Profiles/Agents | `agents.list`, profiles/agents routes | catalog/profile 관리 UI, Account Cell은 profile이 아닌 보안 경계 | `adapted_with_test` |
| Config/Model/Voice | `config.*`, `model.*`, `voice.*`, settings route | light/dark theme와 OAuth status; 나머지는 Hermes Operator 패널 | `operator_only` |
| Browser/Preview | `browser.manage`, `preview.restart` | account-scoped Raw Operator exact 호출 | `operator_only` |
| Setup/Diagnostics | `setup.*`, `verification.status`, `insights.get` | health/upstream diagnostics/verification UI | `adapted_with_test` |
| Billing/Pet | `billing.*`, `credits.view`, `pet.*` | 조회 transport 일부만 허용; 제품 핵심 UI에서 제외 | `operator_only` / `policy_blocked` |

## Termes 고유 확장 기능

다음 기능은 Hermes frame을 바꾸지 않고 별도 Termes domain plane에서 제공한다.

- Project → Task → Plan → specialist blueprint → Hermes session/run 연결
- 질문의 경중·도메인·위험 신호 분류
- 전문 에이전트 능동 생성과 병렬 synthesis
- 필수 agent 전원 완료, 도구 증거, 독립 review 장벽
- Device command, Artifact, Checkpoint, Verification
- account/workspace/runtime cell 소유권과 filesystem/network/resource sandbox
- HttpOnly account session, active cell 재인증, account-scoped GitHub/workspace/SSE/REST/ticket
- 중앙 ChatGPT OAuth refresh authority와 Cell access-token 전달
- 공유 OAuth 및 전역 Hermes operator mutation의 OAuth admin account 제한
- account/project/task ticket 기반 Raw JSON-RPC Operator로 119 exact method 실행

## 완료 규칙

1. `pnpm hermes:sync` 결과에 새 method/event/route가 생기면 미분류 상태로 CI를 실패시킨다.
2. `exact_transport`만으로 UI 완료를 주장하지 않는다.
3. `not_yet_ui`는 전용 Desktop/Mobile flow와 실제 E2E가 생긴 뒤에만 승격한다.
4. `policy_blocked` 변경은 공유 계정 보안과 OAuth-only 원칙을 함께 검토한다.
5. 최종 release에서 `not_yet_ui` 0 또는 마스터가 승인한 명시적 제품 제외 목록만 허용한다.
