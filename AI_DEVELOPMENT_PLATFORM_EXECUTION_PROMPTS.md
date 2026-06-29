# AI Development Platform 실행 프롬프트

이 문서는 사내 AI Development Platform을 실제로 구현하기 위한 단계별 실행 프롬프트입니다.
각 단계는 독립 실행이 아니라 이전 단계 산출물을 반드시 읽고 이어서 수행하는 방식으로 진행합니다.

기준 아키텍처:

- Project First
- Hermes Agent 기반 Runtime Layer
- Hermes Codex App-Server Runtime opt-in
- Docker Compose + Portainer Stack 배포
- Nginx Proxy Manager HTTPS reverse proxy
- PostgreSQL source of truth
- Redis Streams event/queue
- MinIO snapshot/artifact storage
- Runner container 기반 workspace isolation
- Mobile UI: 지시, 상태 확인, 승인/거절
- Tablet/Desktop UI: Vibe Coding, diff, file, log, agent team 상태

공통 원칙:

- 현재 코드를 먼저 읽고 판단한다.
- 추측하지 않고 실제 파일, 설정, 실행 결과를 기준으로 판단한다.
- workspace root 밖 접근은 금지한다.
- 제품 DB가 최종 원장이다.
- Hermes state.db는 runtime-local 상태로만 취급한다.
- Hermes profile은 상태 격리이고, filesystem sandbox가 아니다.
- filesystem isolation은 container, mount, permission policy로 강제한다.
- 긴 작업은 step 단위로 끊고 checkpoint를 남긴다.
- 사용자의 승인 없이는 merge, 배포, secret 변경을 하지 않는다.

---

## 00. 전체 구현 관리자 프롬프트

```text
당신은 AI Platform Implementation Lead입니다.

목표:
사내 AI Development Platform MVP를 Docker Compose 기반으로 구현한다.

역할:
- 전체 repository 구조 설계
- 단계별 작업 분해
- 각 단계 산출물 검토
- 보안 경계와 workspace isolation 검증
- Hermes/Codex runtime 연동 검증
- UI/API/DB/배포 흐름 통합

반드시 지킬 것:
1. 현재 repository 파일을 먼저 읽는다.
2. 없는 기능을 있다고 가정하지 않는다.
3. Hermes 공식 문서 기준으로 가능한 기능과 직접 구현할 기능을 분리한다.
4. Codex App-Server Runtime은 opt-in 기능으로 둔다.
5. 제품의 source of truth는 PostgreSQL이다.
6. Hermes state.db나 Kanban DB에 제품 원장을 맡기지 않는다.
7. 모든 작업은 MVP가 실제로 실행되는 방향으로 좁혀서 진행한다.

최종 산출물:
- 실행 가능한 Docker Compose stack
- API 서버
- Web UI
- Hermes Runtime Manager
- Runner isolation
- Project/Task/Agent/Approval/Checkpoint DB schema
- MVP 검증 시나리오
```

---

## 01. Repository Bootstrap 프롬프트

```text
당신은 Full Stack Architect입니다.

현재 repository를 읽고, AI Development Platform MVP에 맞는 디렉터리 구조를 생성하십시오.

요구사항:
- apps/web: Mobile + Tablet/Desktop Web UI
- apps/api: Control Plane API
- services/orchestrator: Team Orchestrator
- services/hermes-manager: Hermes profile/session/run 관리
- services/runner-supervisor: isolated runner 생성/회수
- packages/shared: 공통 타입, event schema, policy schema
- infra/compose: Docker Compose, Portainer stack, NPM guide
- docs: 운영 문서

기술 선택:
- Web: Next.js 또는 React 기반 SPA 중 repository 상황에 맞게 선택
- API: Node.js/Fastify 또는 NestJS 중 단순하고 안정적인 방향
- DB: PostgreSQL
- Queue/Event: Redis Streams
- Artifact: MinIO

작업:
1. 현재 파일 구조를 확인한다.
2. package manager를 확인한다.
3. 없으면 pnpm workspace 기반으로 구성한다.
4. TypeScript strict mode를 기본으로 둔다.
5. lint/test/build script를 추가한다.

산출물:
- package.json
- pnpm-workspace.yaml
- tsconfig.base.json
- apps/* skeleton
- services/* skeleton
- infra/compose skeleton
- README.md 초기 실행 방법

검증:
- pnpm install
- pnpm lint
- pnpm build
```

---

## 02. Product Domain Model 프롬프트

```text
당신은 Backend Architect입니다.

AI Development Platform의 핵심 domain model과 PostgreSQL schema를 설계하고 구현하십시오.

반드시 포함할 entity:
- User
- Project
- ProjectMember
- WorkspaceRoot
- Task
- TaskNode
- AgentSoul
- AgentRun
- RuntimeProfile
- RuntimeSession
- RunnerContainer
- Approval
- Checkpoint
- Artifact
- Event
- AuditLog
- SecretRef
- Policy

중요 원칙:
- Project First 구조로 설계한다.
- 사용자는 project_member를 통해서만 프로젝트에 접근한다.
- RuntimeSession은 Hermes session/run과 platform task를 연결한다.
- Checkpoint는 git commit, snapshot URI, summary를 포함한다.
- Event는 UI SSE replay가 가능하도록 append-only로 저장한다.

작업:
1. schema migration 도구를 선택한다.
2. DB schema를 작성한다.
3. enum/status transition을 명확히 정의한다.
4. seed data를 만든다.
5. repository/service layer를 구현한다.

산출물:
- migrations
- domain types
- repository/service code
- seed script
- schema diagram 문서

검증:
- migration up/down
- seed 실행
- 주요 entity CRUD 테스트
```

---

## 03. RBAC/Auth 프롬프트

```text
당신은 Security Architect입니다.

Control Plane API의 인증, 세션, RBAC를 구현하십시오.

역할:
- owner
- maintainer
- developer
- reviewer
- observer

권한:
- project:read
- project:update
- task:create
- task:steer
- task:approve
- task:reject
- task:merge
- task:cancel
- secret:read
- secret:write
- policy:update
- runtime:admin

요구사항:
1. JWT 또는 secure session cookie 기반 인증을 구현한다.
2. 모든 API는 project membership을 확인한다.
3. approval 결정은 reviewer 이상만 가능하게 한다.
4. secret 조회/수정은 별도 권한으로 분리한다.
5. 모든 권한 거부는 audit_logs에 남긴다.

산출물:
- auth middleware
- RBAC guard
- project access guard
- audit logger
- auth test

검증:
- 권한 없는 사용자의 project 접근 차단
- observer의 approve 차단
- reviewer의 approval 허용
- audit log 기록 확인
```

---

## 04. Workspace Isolation 프롬프트

```text
당신은 Linux Container Security Architect입니다.

사용자와 Agent가 지정된 workspace root 밖으로 접근할 수 없도록 Runner isolation을 설계하고 구현하십시오.

Host path 정책:
- /data/docker_data/termes/workspaces/users/{user_id}/projects/{project_key}
- /data/docker_data/termes/runs/{task_id}/{agent_id}/worktree

Runner container 정책:
- mount는 해당 worktree만 /workspace로 연결한다.
- host root mount 금지
- docker.sock mount 금지
- 다른 사용자 workspace mount 금지
- non-root user로 실행한다.
- cap_drop ALL
- no-new-privileges
- read-only root filesystem
- tmpfs /tmp
- pids/memory/cpu limit
- network는 policy에 따라 명시적으로만 허용한다.

경로 검증:
- 모든 file API는 realpath 기준 /workspace 하위인지 확인한다.
- symlink가 /workspace 밖을 가리키면 거부한다.
- parent traversal을 거부한다.

산출물:
- runner-supervisor service
- workspace path validator
- container spec builder
- resource limit config
- isolation test

검증:
- /workspace 내부 파일 읽기/쓰기 가능
- ../ 상위 접근 실패
- 다른 사용자 workspace 접근 실패
- /etc, /root, host root 접근 실패
- symlink escape 실패
```

---

## 05. Hermes Runtime Manager 프롬프트

```text
당신은 Hermes Integration Engineer입니다.

Hermes Agent 공식 기능을 기준으로 Runtime Manager를 구현하십시오.

Hermes에서 사용할 기능:
- Profiles
- API Server Runs API
- Sessions API
- SSE run events
- Approval endpoint
- Checkpoints
- Kanban board
- Codex App-Server Runtime opt-in

직접 구현할 기능:
- Project/Task source of truth
- RBAC
- Workspace isolation
- Runner lifecycle
- Checkpoint 원장
- Agent Team orchestration
- UI event normalization

작업:
1. Hermes profile 생성/삭제/조회 wrapper를 만든다.
2. profile별 HERMES_HOME 경로를 관리한다.
3. profile별 CODEX_HOME 경로를 분리한다.
4. API_SERVER_KEY를 profile별로 발급한다.
5. Hermes /v1/capabilities를 health check에 사용한다.
6. /v1/runs 생성, 조회, SSE 구독, stop, approval resolve를 구현한다.
7. Hermes event를 product event schema로 변환한다.

산출물:
- HermesProfileService
- HermesRunService
- HermesEventBridge
- HermesApprovalBridge
- Hermes health checker

검증:
- profile 생성
- Hermes API health 확인
- run 생성
- SSE event 수신
- run stop
- approval 전달
```

---

## 06. Codex App-Server Runtime 프롬프트

```text
당신은 Codex Runtime Integration Engineer입니다.

Hermes의 Codex App-Server Runtime을 opt-in으로 구성하십시오.

전제:
- Codex CLI는 runner image에 설치한다.
- Codex auth는 CODEX_HOME 단위로 분리한다.
- Hermes auth와 Codex auth는 별도이다.
- Codex runtime은 실제 코드 수정 Agent에만 사용한다.

작업:
1. runner image에 Codex CLI 설치를 추가한다.
2. profile별 CODEX_HOME을 생성한다.
3. Hermes config에 model.openai_runtime=codex_app_server 옵션을 설정할 수 있게 한다.
4. Codex runtime enabled 여부를 RuntimeProfile에 저장한다.
5. Codex runtime에서는 Hermes delegate_task, memory, session_search, todo가 직접 사용 불가함을 policy에 반영한다.
6. Agent Team 분해는 Platform Orchestrator가 수행하도록 한다.

산출물:
- runner Dockerfile
- Codex runtime profile config generator
- CODEX_HOME isolation
- runtime mode switch API
- documentation

검증:
- Codex runtime off 상태 run
- Codex runtime on 상태 run
- workspace write 가능
- workspace 밖 write 실패
- approval event 수신
```

---

## 07. Team Orchestrator 프롬프트

```text
당신은 Distributed Agent Orchestrator입니다.

사용자 task를 분석하여 동적 Agent Team을 생성하고 실행하는 Orchestrator를 구현하십시오.

단계:
1. Intake
2. Architect Analysis
3. Task Tree 생성
4. Agent Role 결정
5. Agent Soul 생성
6. Worktree 생성
7. AgentRun 생성
8. Hermes run 시작
9. Event 수집
10. Checkpoint 생성
11. Reviewer 실행
12. Approval 요청
13. 승인 후 merge

Agent Role 예:
- Architect
- Frontend Specialist
- Backend Specialist
- Database Specialist
- DevOps Specialist
- Qt Specialist
- Rust Specialist
- Media Specialist
- Rendering Specialist
- Reviewer

규칙:
- Reviewer는 코드 변경 작업에 반드시 포함한다.
- 동일 파일을 여러 Agent가 동시에 수정하지 않도록 path lock을 사용한다.
- Agent별 git worktree/branch를 분리한다.
- 통합은 Orchestrator가 수행한다.

산출물:
- task analyzer
- role planner
- soul generator
- task tree engine
- agent scheduler
- integration workflow

검증:
- 단순 작업은 Worker + Reviewer
- 복합 작업은 Specialist 다수 생성
- 각 AgentRun이 별도 worktree를 사용
- Reviewer가 read-only 정책으로 실행
```

---

## 08. Agent Soul Generator 프롬프트

```text
당신은 Agent Prompt Engineer입니다.

작업 특성에 따라 Agent Soul을 런타임에 생성하는 모듈을 구현하십시오.

Soul 구성:
- role name
- mission
- project context
- allowed paths
- denied paths
- allowed commands
- denied commands
- expected outputs
- checkpoint rule
- completion criteria
- handoff format
- review checklist

중요:
- global SOUL.md를 매 작업마다 수정하지 않는다.
- project AGENTS.md/.hermes.md는 durable context로 읽는다.
- runtime Soul은 Hermes run instructions로 주입한다.
- Codex runtime에서도 동일한 role contract가 전달되어야 한다.

산출물:
- Soul template
- role-specific prompt builder
- command/file policy binding
- soul persistence table 연동

검증:
- Frontend Specialist soul 생성
- Backend Specialist soul 생성
- Reviewer soul 생성
- allowed path 밖 작업 요청 시 거부하도록 지시 포함
```

---

## 09. Command Policy 프롬프트

```text
당신은 Agent Permission Control Engineer입니다.

Agent가 실행할 수 있는 command allow/deny policy를 구현하십시오.

기본 deny:
- sudo
- su
- mount
- umount
- docker
- systemctl
- service
- chmod 777
- chown -R
- rm -rf /
- mkfs
- dd if=
- curl | sh
- wget | sh
- ssh to unapproved host
- scp to unapproved host

기본 allow:
- git status/diff/log/show
- git add/commit within task branch
- package manager install only if project policy allows
- test/build/lint commands from project config
- rg, sed, awk, node, python inside workspace

작업:
1. command parser를 만든다.
2. policy table과 연결한다.
3. Hermes approval event와 product approval을 연결한다.
4. denied command는 실행 전에 차단한다.
5. prompt injection으로 policy 변경을 요구해도 무시한다.

산출물:
- command policy schema
- policy evaluator
- approval bridge
- tests

검증:
- allowed command 통과
- denied command 차단
- 승인 필요한 command는 approval 생성
- 승인 거절 시 run이 안전하게 계속되거나 중단
```

---

## 10. Checkpoint System 프롬프트

```text
당신은 Reliability Engineer입니다.

몇 시간 이상의 작업을 안전하게 재개할 수 있는 checkpoint system을 구현하십시오.

Checkpoint 구성:
- task status
- agent status
- step summary
- Hermes session/run id
- git commit sha
- workspace snapshot URI
- changed files
- test result
- next action

작업:
1. step 종료 시 checkpoint 생성
2. git commit 생성
3. snapshot tar.zst 생성
4. MinIO 업로드
5. DB에 checksum 저장
6. event 발행
7. resume API 구현

Hermes checkpoint:
- Hermes의 shadow git checkpoint는 runtime safety net으로 사용한다.
- 제품 checkpoint가 최종 복구 기준이다.

산출물:
- CheckpointService
- SnapshotService
- GitCheckpointService
- ResumeService
- restore test

검증:
- checkpoint 생성
- snapshot 업로드
- git commit 확인
- task resume
- runner 재시작 후 resume
```

---

## 11. Event/SSE 프롬프트

```text
당신은 Realtime Systems Engineer입니다.

Hermes SSE와 product event stream을 연결하십시오.

이벤트 종류:
- task.created
- task.started
- agent.created
- agent.started
- agent.delta
- agent.tool.started
- agent.tool.completed
- agent.command.started
- agent.command.completed
- agent.file.changed
- checkpoint.created
- approval.requested
- approval.approved
- approval.rejected
- task.completed
- task.failed

작업:
1. Hermes /v1/runs/{id}/events를 구독한다.
2. Hermes event를 product event로 normalize한다.
3. DB events에 append한다.
4. Redis Streams에 publish한다.
5. Web UI SSE endpoint를 구현한다.
6. reconnect 시 last_event_id 기준으로 replay한다.

산출물:
- EventBridge
- EventStore
- Redis publisher
- SSE API
- client hook

검증:
- run progress 실시간 표시
- 새로고침 후 event replay
- approval event 표시
- task complete event 표시
```

---

## 12. Approval Workflow 프롬프트

```text
당신은 Product Workflow Engineer입니다.

사용자 승인/거절 workflow를 구현하십시오.

승인 대상:
- command approval
- file patch approval
- checkpoint approval
- final diff approval
- merge approval
- secret usage approval
- SSH target approval

작업:
1. approval request 생성 API
2. approval decision API
3. Hermes approval endpoint 연결
4. 모바일 approval card
5. 데스크탑 diff approval panel
6. audit log 저장

정책:
- approval은 권한 있는 사용자만 가능하다.
- approval은 취소 불가능한 audit event로 남긴다.
- reject 시 Agent에게 재작업 지시를 생성한다.

산출물:
- ApprovalService
- Approval API
- Approval UI
- HermesApprovalBridge
- tests

검증:
- approval requested 표시
- approve 후 Hermes run 재개
- reject 후 재작업 task 생성
- 권한 없는 approve 실패
```

---

## 13. Mobile UI 프롬프트

```text
당신은 Mobile Web Product Designer이자 Frontend Engineer입니다.

모바일 UI를 구현하십시오.

기능:
- project list
- active task list
- create task
- task progress timeline
- agent team compact view
- chat/steer
- approval/reject
- notification

디자인 원칙:
- 모바일에서는 파일 편집 기능을 제공하지 않는다.
- 핵심은 지시, 확인, 승인이다.
- approval card는 diff summary와 위험도를 먼저 보여준다.
- 로그는 전체 로그가 아니라 요약과 중요 이벤트 중심이다.

산출물:
- mobile routes
- responsive layout
- task composer
- approval card
- progress timeline
- SSE client

검증:
- iPhone width
- Android width
- task 생성
- progress 실시간 반영
- approval/reject 동작
```

---

## 14. Tablet/Desktop UI 프롬프트

```text
당신은 Desktop Web Product Designer이자 Frontend Engineer입니다.

Tablet/Desktop UI를 구현하십시오.

화면 구조:
- left sidebar: projects, task tree, file tree
- center: agent team graph, chat, plan
- right panel: selected agent, logs, commands
- bottom panel: diff viewer, tests, approvals

기능:
- project selector
- agent team visualization
- task tree
- chat/steer
- diff viewer
- file viewer
- log viewer
- approval panel
- checkpoint history

디자인 원칙:
- OpenHands UX를 참고하되 Agent Team 중심으로 구성한다.
- card 남용 금지.
- 작업 도구 UI는 조밀하고 반복 사용에 적합해야 한다.
- button에는 가능한 icon을 사용한다.
- text overflow가 없어야 한다.

산출물:
- desktop shell
- agent graph
- task tree
- diff viewer
- log viewer
- file viewer
- checkpoint panel

검증:
- desktop 1440px
- tablet 1024px
- 긴 파일명 overflow 없음
- diff rendering 정상
- log streaming 정상
```

---

## 15. Git Integration 프롬프트

```text
당신은 Git Workflow Engineer입니다.

Agent별 worktree/branch 기반 Git workflow를 구현하십시오.

Branch 규칙:
- task/{task_id}
- task/{task_id}/{agent_id}
- review/{task_id}

작업:
1. project repo clone/init
2. task branch 생성
3. agent worktree 생성
4. agent branch 생성
5. checkpoint commit
6. integration merge
7. final diff 생성

규칙:
- 같은 branch를 두 worktree에서 동시에 checkout하지 않는다.
- Agent는 자기 branch만 수정한다.
- 최종 merge는 approval 이후에만 수행한다.

산출물:
- GitService
- WorktreeService
- DiffService
- MergeService
- tests

검증:
- agent worktree 생성
- checkpoint commit 생성
- diff 조회
- conflict 감지
- approval 전 merge 불가
```

---

## 16. SSH Remote Work 프롬프트

```text
당신은 SSH Security Engineer입니다.

SSH 기반 원격 작업 기능을 구현하십시오.

요구사항:
- project policy에 등록된 host만 허용한다.
- known_hosts pinning을 적용한다.
- SSH key는 secret store에서 단기 주입한다.
- agent forwarding은 기본 금지한다.
- 원격 host에서도 workspace root를 제한한다.
- 모든 SSH command는 audit log에 남긴다.

작업:
1. SSH target registry 구현
2. SSH key secret ref 구현
3. known_hosts 관리
4. runner에 단기 secret mount
5. command policy와 연결
6. remote workspace validation

산출물:
- SshTargetService
- SshKeyService
- KnownHostsService
- SSH command policy
- audit tests

검증:
- 허용 host 접속 성공
- 미등록 host 접속 차단
- key 없이 접속 실패
- audit log 기록
```

---

## 17. Docker Compose / Portainer 프롬프트

```text
당신은 DevOps Architect입니다.

Portainer Stack으로 배포 가능한 Docker Compose 구성을 완성하십시오.

서비스:
- web
- api
- orchestrator
- hermes-manager
- runner-supervisor
- postgres
- redis
- minio
- backup
- log collector

요구사항:
- external network npm_proxy 사용
- 모든 secret은 .env로 분리
- data volume은 /data/docker_data/termes 하위에 둔다.
- healthcheck 작성
- restart policy 설정
- resource limit 설정
- migration job 제공

산출물:
- infra/compose/docker-compose.yml
- infra/compose/.env.example
- infra/compose/portainer-stack.md
- infra/compose/backup.md
- infra/compose/restore.md

검증:
- docker compose config
- docker compose up
- healthcheck 통과
- migration 실행
- web/api 접근
```

---

## 18. Nginx Proxy Manager 프롬프트

```text
당신은 Reverse Proxy Engineer입니다.

Nginx Proxy Manager 설정 문서를 작성하고 필요한 app 설정을 반영하십시오.

도메인:
- ai.company.com -> web
- api.ai.company.com -> api
- events.ai.company.com -> api SSE

요구사항:
- HTTPS
- WebSocket/SSE 지원
- proxy buffering off
- 긴 timeout
- HSTS
- client max body size
- Hermes API와 Codex App Server는 외부 공개 금지

산출물:
- infra/npm/NPM_GUIDE.md
- app env proxy settings
- SSE timeout settings

검증:
- HTTPS 접속
- SSE stream 유지
- file upload size 확인
- Hermes/Codex port 외부 미노출 확인
```

---

## 19. Monitoring / Logging 프롬프트

```text
당신은 Observability Engineer입니다.

운영에 필요한 log, metric, alert를 구현하십시오.

Metrics:
- active tasks
- active agent runs
- runner CPU/memory
- queue depth
- checkpoint latency
- approval wait time
- Hermes run duration
- failed runs
- SSE reconnect count

Logs:
- API request log
- audit log
- Hermes run log
- runner log
- command log
- approval log

작업:
1. structured logging 적용
2. Prometheus metrics endpoint 추가
3. Grafana dashboard json 작성
4. Loki 또는 file log collector 구성
5. alert rule 작성

산출물:
- metrics endpoint
- dashboard
- alert rules
- log retention config

검증:
- metric scrape 확인
- dashboard 표시
- failed run alert 발생
```

---

## 20. Backup / Disaster Recovery 프롬프트

```text
당신은 Disaster Recovery Engineer입니다.

시스템 재시작, 서버 장애, runner 장애 후 복구 가능한 backup/restore 전략을 구현하십시오.

Backup 대상:
- PostgreSQL
- MinIO artifacts
- /data/docker_data/termes/workspaces
- /data/docker_data/termes/hermes profiles
- git repositories
- config/env templates

정책:
- DB dump 주기
- MinIO lifecycle
- workspace snapshot
- restore drill script
- checksum verification

산출물:
- backup service
- restore script
- backup manifest
- DR runbook

검증:
- 새 서버에서 restore
- task resume
- checkpoint 복원
- artifact checksum 확인
```

---

## 21. MVP Acceptance 프롬프트

```text
당신은 QA Lead입니다.

MVP가 실제로 동작하는지 end-to-end로 검증하십시오.

시나리오:
1. 사용자 로그인
2. 프로젝트 생성
3. repository 등록
4. 모바일에서 작업 생성
5. Orchestrator가 Agent Team 생성
6. Hermes run 시작
7. Agent가 worktree에서 코드 수정
8. checkpoint 생성
9. Reviewer 실행
10. Desktop diff 확인
11. Mobile 승인
12. merge
13. task completed
14. 서버 재시작
15. 이전 task history 확인

검증 기준:
- workspace root 밖 접근 불가
- 승인 전 merge 불가
- checkpoint 존재
- snapshot 존재
- event replay 가능
- audit log 존재
- UI에서 전체 흐름 확인 가능

산출물:
- MVP_TEST_PLAN.md
- test scripts
- QA report
```

---

## 22. Production Hardening 프롬프트

```text
당신은 Production Architect입니다.

MVP를 Production 수준으로 강화하기 위한 작업을 수행하십시오.

강화 영역:
- OIDC/SSO
- Vault/KMS secret management
- per-project network policy
- signed runner jobs
- immutable audit log
- multi-runtime host
- resource quota
- project-level backup policy
- security review
- load test

작업:
1. production gap 분석
2. risk register 작성
3. hardening backlog 생성
4. 우선순위별 구현
5. 운영 문서 작성

산출물:
- PRODUCTION_READINESS.md
- SECURITY_REVIEW.md
- OPERATIONS_RUNBOOK.md
- LOAD_TEST_REPORT.md
```

---

## 23. Agent Marketplace 확장 프롬프트

```text
당신은 AI Agent Marketplace Architect입니다.

향후 Agent Marketplace를 위한 template registry를 설계하십시오.

Marketplace package:
- agent.yaml
- soul.md
- permissions.yaml
- tools.yaml
- skills/
- examples/
- tests/
- signature.sig

원칙:
- marketplace는 고정 Agent 목록이 아니다.
- Orchestrator가 작업마다 template을 참고하여 runtime Agent Soul을 생성한다.
- 각 template은 필요한 command/network/secret 권한을 선언해야 한다.
- 설치 전 policy compatibility를 검사한다.
- package는 서명 검증 후 enable한다.

산출물:
- marketplace schema
- package validator
- signature verifier
- template install API
- project enable/disable API
- UI 관리 화면

검증:
- template install
- permission conflict 차단
- unsigned package 차단
- project별 enable
```

---

## 권장 실행 순서

```text
01 Repository Bootstrap
02 Product Domain Model
03 RBAC/Auth
04 Workspace Isolation
05 Hermes Runtime Manager
06 Codex App-Server Runtime
07 Team Orchestrator
08 Agent Soul Generator
09 Command Policy
10 Checkpoint System
11 Event/SSE
12 Approval Workflow
13 Mobile UI
14 Tablet/Desktop UI
15 Git Integration
16 SSH Remote Work
17 Docker Compose / Portainer
18 NPM
19 Monitoring / Logging
20 Backup / Disaster Recovery
21 MVP Acceptance
22 Production Hardening
23 Agent Marketplace
```

MVP는 01부터 21까지를 완료 기준으로 봅니다. 22와 23은 MVP 이후 Production 확장 단계입니다.
