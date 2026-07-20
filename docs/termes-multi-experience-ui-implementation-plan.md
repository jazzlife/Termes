# Termes Multi-Experience UI 구현 설계

> 상태: 구현 정본
> 기준일: 2026-07-13
> 1차 구현 Gate: Mobile Chat Experience
> 후속 Gate: Tablet Review → Desktop Workstation

## 1. 결정

Termes는 하나의 인증·Project·Task·Hermes runtime을 공유하되 사용자 작업 환경은 세 개의 독립 Experience로 구현한다.

```text
Shared Termes AppKernel
  ├─ Mobile Chat Experience
  ├─ Tablet Review Experience
  └─ Desktop Workstation Experience
```

공유 대상은 domain contract, API client, realtime projection, account policy, semantic theme token과 저수준 UI primitive다. 화면 shell, navigation, 정보 밀도, 기능 composition은 Experience별로 분리한다.

1차 구현은 전체 계약을 먼저 확정한 후 Mobile Chat Experience까지만 완료한다. Tablet과 Desktop은 타입·capability·lazy import 경계만 만들고 화면은 구현하지 않는다.

## 2. 현재 코드 기준

- `apps/web/src/main.tsx`의 단일 `App`이 Account, Project, Task, Conversation, Device, Workbench, Hermes Operator를 모두 소유한다.
- `MobileView`는 `list | chat | workbench`이며 별도의 모바일 React tree가 아니다.
- `apps/web/src/styles.css`의 560·760·820·900·1180px media query가 같은 DOM을 숨기고 재배치한다.
- 모바일에서도 Diff·Terminal·Files·Logs·Hermes Raw Operator와 Device 제어 UI에 접근할 수 있다.
- Task Conversation은 현재 SSE 알림 후 runtime snapshot을 다시 읽어 갱신한다.
- `HermesRealtimeClient`는 존재하지만 현재 Conversation projection의 유일한 store가 아니므로 UI 작업 중 transport를 임의로 바꾸지 않는다.
- IDE editor와 interactive terminal UI 의존성은 현재 Web package에 없다.

1차 작업은 현재 데이터 동작을 보존하면서 UI 경계부터 분리한다.

## 3. Experience 선택

### 3.1 타입

```ts
type ExperienceKind = "mobile" | "tablet" | "desktop";
type ExperiencePreference = "auto" | ExperienceKind;

type ExperienceEnvironment = {
  viewportWidth: number;
  finePointer: boolean;
  hover: boolean;
};
```

### 3.2 자동 선택 규칙

```text
viewport < 820
  → mobile

viewport >= 1180 AND fine pointer AND hover
  → desktop

그 외
  → tablet
```

user-agent 문자열은 사용하지 않는다. 작은 데스크톱 창은 Review Experience가 되고, 넓은 화면이라도 정밀 포인터와 hover가 없으면 Tablet Review가 된다. 사용자는 지원되는 환경에서 낮은 Experience로 전환할 수 있지만 화면 선택으로 서버 권한이 상승하지 않는다.

### 3.3 최종 capability

```text
Effective Capability
  = Hermes upstream capability
  ∩ Account/Role policy
  ∩ Project/Task context
  ∩ Experience policy
```

Experience Resolver는 표시와 client interaction만 결정한다. Device, filesystem, process, runtime 설정은 서버가 account와 Project scope를 다시 검증한다.

## 4. Experience capability matrix

상태는 `full`, `summary_only`, `read_only`, `not_exposed`, `planned`, `policy_blocked`로 관리한다.

| 기능 | Mobile Chat | Tablet Review | Desktop Workstation |
| --- | --- | --- | --- |
| Account session | full | full | full |
| OpenAI OAuth 상태 | full | full | full |
| Project 선택 | full | full | full |
| Workspace/GitHub 등록 관리 | not_exposed | read_only | full |
| Task 생성·선택·후속 질문 | full | full | full |
| Markdown·실시간 답변 | full | full | full |
| Routing 결과 | summary_only | full | full |
| 전문 에이전트 협업 | summary_only | read_only | full |
| Plan | 현재 단계·목록 | read_only | full |
| Approval·Clarify·Sudo·Secret | full | full | full |
| Tool | summary_only | read_only | full |
| 변경 파일 | 목록·개수·검증 | read_only | full |
| Diff | not_exposed | read_only | full |
| File/Image/PDF attach | planned | planned | operator_only |
| Terminal | not_exposed | 출력 log만 | interactive |
| Process/Shell | 상태만 | read_only | full |
| Device | 상태·요청 승인 | 상태·결과 | full |
| Artifact | 안전한 preview | 상세 preview | full |
| Verification | full | full | full |
| Runtime diagnostics | 연결 상태 | 제한 health | operator full |
| Raw JSON-RPC | not_exposed | not_exposed | operator only |
| Billing/Pet | policy_blocked | policy_blocked | policy_blocked |

## 5. 목표 코드 구조

```text
apps/web/src/
  app/
    AppKernel.tsx
    ExperienceResolver.tsx
    capability-resolver.ts
    experience.ts
    providers/ThemeProvider.tsx

  domain/
    account/
    projects/
    tasks/
    conversation/
    runtime/
    interactions/
    orchestration/
    verification/

  experiences/
    mobile/
      MobileExperience.tsx
      mobile.css
      screens/
        MobileTaskListScreen.tsx
        MobileConversationScreen.tsx
        MobileActivityScreen.tsx
        MobileSettingsScreen.tsx
      components/
        MobileHeader.tsx
        MobileTaskRow.tsx
        MobilePlanStrip.tsx
        MobileMessageTimeline.tsx
        MobileToolGroup.tsx
        MobileInteractionCard.tsx
        MobileSpecialistSummary.tsx
        MobileComposer.tsx
    tablet/contract.ts
    desktop/contract.ts

  shared/
    api/
    realtime/
    state/
    theme/
    ui/
```

기존 `main.tsx`의 API 호출과 controller를 한 번에 전부 이동하지 않는다. 먼저 `AppKernel` interface를 정의하고 현재 구현을 adapter로 연결한다. 각 단계에서 기존 Task 생성, 후속 질문, interaction, 선택 복원이 통과해야 다음 controller를 이동한다.

## 6. AppKernel 계약

```ts
type TermesAppKernel = {
  account: AccountProjection;
  projects: ProjectProjection;
  tasks: TaskProjection;
  conversation: ConversationProjection;
  runtime: RuntimeProjection;
  interactions: InteractionProjection;
  orchestration: OrchestrationProjection;
  verification: VerificationProjection;
  connection: ConnectionProjection;
  actions: {
    selectProject(projectId: string): Promise<void>;
    selectTask(taskId: string): Promise<void>;
    createTask(input: CreateTaskInput): Promise<void>;
    sendFollowUp(input: FollowUpInput): Promise<void>;
    resolveInteraction(input: InteractionResponse): Promise<void>;
    refresh(): Promise<void>;
    logout(): Promise<void>;
  };
};
```

Kernel은 화면 이동, drawer, pane, scroll, theme menu와 같은 UI 상태를 소유하지 않는다. 현재 SSE + runtime snapshot 동작은 Kernel adapter 안에 보존한다. direct JSON-RPC projection 전환은 별도 data Gate이며 모바일 JSX 변경과 섞지 않는다.

## 7. Mobile Chat Experience

### 7.1 화면 상태

```ts
type MobileScreen = "tasks" | "conversation" | "activity" | "settings";
```

```text
MobileRoot
  ├─ TaskListScreen
  ├─ ConversationScreen
  ├─ ActivityScreen
  │   ├─ Needs input
  │   ├─ Plan
  │   ├─ Specialist summary
  │   ├─ Tool summary
  │   ├─ Changes summary
  │   ├─ Artifacts
  │   └─ Verification
  └─ SettingsScreen
```

browser back은 `conversation → tasks`, `activity/settings → conversation` 순서로 동작한다. 선택한 Project와 Task는 화면 상태와 분리하여 유지한다.

### 7.2 Task 목록

- safe area 아래 56px header
- 현재 Project를 한 줄 switcher로 표시
- search와 New Task만 직접 action으로 노출
- Task row 최소 72px, title 15px, preview 13px, 상태·시각 12px
- row divider 사용, 독립 card 반복 금지
- 활성 Task는 2px leading indicator와 primary-soft surface
- Workspace/GitHub 관리 UI는 모바일 shell에 상시 노출하지 않음

### 7.3 Conversation

- header는 back, Task title, Activity, overflow만 표시
- Project와 runtime 연결 상태는 12px secondary 한 줄
- Plan은 header 아래 compact strip
- Agent 답변은 bubble 없는 Markdown prose
- 사용자 질문은 우측 정렬 primary-soft bubble
- reasoning은 기본 접힘
- tool은 이름·상태·요약을 하나의 group으로 표시
- routing과 전문 에이전트는 요약 행으로 표시하고 Activity에서 상세 목록 확인
- interaction은 발생한 turn 안에 렌더링하고 미응답이면 composer 위 action strip도 표시
- changes는 파일 수와 검증 상태만 표시하며 전체 Diff는 제공하지 않음

### 7.4 Composer

```ts
type MobileComposerMode = "new_task" | "follow_up";
```

- 입력 글자 16px
- 초기 최소 높이 76px, 최대 40dvh, 내용에 따라 자동 증가
- send/stop 44px
- safe area 위 12px
- VisualViewport로 keyboard inset 계산
- composer 실측 높이를 conversation bottom clearance에 반영
- capability가 없는 Queue/Steer는 다른 command로 대체하지 않고 숨김

### 7.5 Activity

Mobile Activity는 Needs input, Plan, specialist/tool summary, changed files, Artifact, Verification, connection/resync만 제공한다.

다음은 모바일 React tree에서 제외한다.

- full Diff viewer와 file editor
- interactive Terminal과 raw Logs
- Device 등록·수정·삭제·임의 명령
- Hermes Audit/Profile/Session/Job 관리
- Raw JSON-RPC console
- 전체 runtime diagnostics

### 7.6 Settings

- Light/Dark/System
- 현재 Account와 workspace key
- OpenAI 공유 OAuth 연결 상태
- OAuth 관리 권한이 있는 Account만 연결 action 표시
- logout
- 시스템 runtime 설정은 표시하지 않음

## 8. Theme와 viewport

- `ThemeMode = light | dark | system`
- preference는 versioned local storage key에 저장
- pre-paint bootstrap이 `data-theme`와 `color-scheme` 설정
- system media query 변경 구독
- input/select/textarea 16px 이상, 의미 정보 12px 이상
- 주요 action 44×44px 이상
- `viewport-fit=cover`, `env(safe-area-inset-*)`, `100dvh` 사용
- VisualViewport resize/scroll로 keyboard inset을 CSS variable에 전달

## 9. 1차 구현 단계와 Gate

### M0. 설계 동결

- 이 문서, design system, Experience matrix 확정
- Tablet/Desktop은 contract만 정의
- 현재 화면과 selector inventory 확보

### M1. Experience foundation

- `ExperienceResolver`와 순수 함수 테스트
- capability resolver와 Mobile policy
- Mobile entry 연결
- Tablet/Desktop은 현재 legacy experience 유지

완료 조건: 819/820/1179/1180 경계와 pointer/hover 조합 테스트.

### M2. Theme·viewport foundation

- semantic token, Light/Dark/System ThemeProvider, pre-paint bootstrap
- viewport-fit, safe area, VisualViewport keyboard metric

완료 조건: theme flash와 keyboard overlap 없음.

### M3. Mobile Task navigation

- Project switcher, Task list/search/select, New Task 진입
- Project/Task 삭제 후 selection 복원

완료 조건: list → conversation → back과 빈 상태 안정화.

### M4. Mobile Conversation

- stored Markdown와 live text/reasoning/tool projection
- routing/specialist summary, compact Plan
- Approval/Clarify/Sudo/Secret
- New Task/Follow-up composer

완료 조건: 저장·live·새로고침 복원 순서 동일.

### M5. Mobile Activity·Settings

- Plan, tools, specialists, changes, artifacts, verification
- account/OAuth/theme/logout
- 모바일 제한 기능 제거

완료 조건: 모바일 DOM에 operator/editor/terminal UI 없음.

### M6. 검증·개선

- typecheck와 production build
- Node unit test
- mobile browser E2E와 screenshot
- 실제 OAuth session과 Hermes Task 검증
- 390×844, 430×932, landscape 검증

## 10. 1차 완료 정의

### 기능

1. 로그인 후 Project와 Task를 선택할 수 있다.
2. New Task와 Follow-up이 혼동되지 않는다.
3. 단순 문맥 질문은 직접 응답 경로로 표시되고 전문 에이전트 UI가 불필요하게 생성되지 않는다.
4. 구현 요청은 전문 에이전트 경로와 협업 진행이 표시된다.
5. text, reasoning, tool, interaction, plan, verification이 새로고침 후 동일한 상태로 수렴한다.
6. Project 삭제 후 남은 Project/Task 또는 빈 상태가 정상 표시된다.
7. 장시간 실행 Task를 다시 열어 같은 상태를 복원한다.
8. 모바일 제한 기능을 호출할 UI와 handler가 없다.

### 시각·접근성

1. 390×844, 430×932와 landscape에서 가로 overflow가 없다.
2. 입력은 16px 이상, 의미 정보는 12px 이상이다.
3. 주 action은 44×44px 이상이다.
4. Light/Dark/System에서 정보 위계가 동일하다.
5. keyboard가 composer와 마지막 message를 가리지 않는다.
6. reduced motion과 visible focus를 지원한다.

### 데이터·성능

1. runtime projection의 메시지 중복이 생기지 않는다.
2. reconnect 후 snapshot이 현재 Task로 수렴한다.
3. delta 단위로 Project/Task shell 전체가 갱신되지 않는다.
4. 긴 대화의 DOM 수를 제한하거나 virtualization한다.
5. 모바일 초기 chunk에 향후 editor·terminal·full Diff가 포함되지 않는다.
6. Secret 입력값은 projection, DB, audit log에 남지 않는다.

## 11. 테스트 설계

### Unit

- `experience-resolver.test.ts`: 경계와 pointer/hover
- `capability-resolver.test.ts`: upstream/account/context/experience 교집합
- `mobile-navigation.test.ts`: screen transition과 selection 유지
- `mobile-selection-regression.test.ts`: Project 삭제 후 재생성·Task·chat 복원

### Integration

- Task 생성과 Follow-up API 분리
- interaction response와 pending 상태 제거
- SSE reconnect와 runtime snapshot reconcile
- specialist direct/orchestrated 분류 표시

### Browser E2E

- Account login, Project/Task 선택
- 직접 응답 질문과 전문 에이전트 구현 질문
- Approval/Clarify, Activity와 back, theme 전환
- keyboard open/close, 제한 기능 DOM 부재, 장시간 Task 재진입

### Bundle

- production manifest에서 Mobile initial dependency 검사
- editor, terminal, full-diff chunk의 Mobile eager import 금지

## 12. 후속 Gate 계약

### Tablet Review

- 2-pane Task/Conversation/Review
- 읽기 전용 file tree와 code viewer
- read-only unified/split Diff
- Artifact와 Verification 상세 검토
- process/tool log 열람
- file edit, interactive terminal, system mutation 제외

### Desktop Workstation

- Project/Task rail + editor/conversation + activity/system pane
- IDE급 file tree, tabs, source editor, search
- editable Diff와 apply/revert
- interactive terminal과 process lifecycle
- authorized Device와 runtime control
- 전문 에이전트 생성·중단·재실행과 Plan 실행 제어

후속 Gate는 Mobile screen component를 재배치하지 않는다. AppKernel과 domain projection을 사용해 각 Experience screen을 별도로 구현한다.
