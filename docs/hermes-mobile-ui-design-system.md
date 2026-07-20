# Termes Mobile UI·Typography·Theme 설계 기준

> **기능·동작 정본:** 시각 규칙은 이 문서를 따르되 Hermes 기능·interaction·성능 동작은
> [`hermes-termes-parity-master-plan.md`](./hermes-termes-parity-master-plan.md)를 따른다.
> 화면 정리를 이유로 Hermes capability를 제거하거나 단순화하지 않는다.
> 실제 UI 구현은 [`hermes-termes-implementation-execution-plan.md`](./hermes-termes-implementation-execution-plan.md)의
> 연결·데이터 안정화 Gate S6와 내부 계정·workspace sandbox Gate S7 통과 후 시작한다.
>
> **Experience 구현 정본:** Mobile/Tablet/Desktop을 별도 제품 경험으로 분리하는 구조와 1차 Mobile 범위는
> [`termes-multi-experience-ui-implementation-plan.md`](./termes-multi-experience-ui-implementation-plan.md)를 따른다.
> 이 문서의 기존 공용 반응형 component 규칙과 충돌하면 Multi-Experience 정본을 우선한다.

## 1. 목적

이 문서는 Termes의 Web/PWA UI를 Hermes Mobile처럼 조용하고 읽기 쉬운 화면으로 정리하기 위한 구현 기준이다. Hermes의 화면을 복제하지 않고 다음 장점을 Termes 제품 구조에 맞게 적용한다.

- 적은 수의 명확한 글자 단계
- 넉넉하지만 낭비되지 않는 모바일 여백
- 장식보다 내용이 먼저 보이는 conversation
- 44px 이상의 안정적인 터치 영역
- 16px 입력 글자로 iOS 자동 확대 방지
- safe area와 keyboard를 고려한 floating composer
- light/dark가 같은 semantic 의미를 갖는 theme token
- 설정·상세 화면의 full-screen master/detail 전환

Termes의 핵심인 Project, Task, Plan, Tool, Approval, Device, Artifact, Verification은 제거하지 않는다. 대화 화면을 가볍게 유지하되 작업 상태는 Activity 계층에서 정확히 확인할 수 있어야 한다.

## 2. 디자인 기준 자료

### 현재 코드

- `apps/web/src/main.tsx`
- `apps/web/src/styles.css`
- `.superdesign/init/*`
- `.superdesign/design-system.md`

### Hermes 구현

- `apps/mobile/src/styles.css`
- `apps/mobile/App.native.tsx`
- `apps/desktop/src/themes/context.tsx`
- `apps/desktop/src/themes/types.ts`

### SuperDesign 검증본

- [현재 Termes 모바일 재현본](https://p.superdesign.dev/draft/0aa8a9b4-7bed-4726-8c89-56ae1a46ebe3)
- [Termes Mobile Light Refinement](https://p.superdesign.dev/draft/385e18bd-65e7-41f0-ac6a-2a0de33e12c9)
- [SuperDesign 프로젝트](https://superdesign.dev/teams/04638476-c9ef-4408-bf70-1981dc6c26fa/projects/21b797f6-7bc0-4d02-94de-ee8486d2ad9e)

SuperDesign 변형은 시각 방향을 확인하기 위한 기준이다. 실제 구현의 최종 계약은 이 문서가 우선한다.

## 3. 현재 Termes UI에서 정리해야 할 문제

### 3.1 Typography 단계가 지나치게 잘게 나뉨

현재 CSS에는 10, 11, 12, 13, 14, 16, 17, 18, 19px이 섞여 있다. 특히 Task 상태, Plan step, Verification, Device 정보에 10~12px이 자주 사용되어 모바일에서 의미 있는 정보가 metadata처럼 축소된다.

문제:

- 같은 중요도의 문장이 서로 다른 크기로 표시됨
- 11px 정보가 많아 사용자가 화면을 확대해서 읽게 됨
- 영문과 한글의 실제 시각 크기가 달라 계층이 흔들림
- font-weight가 700~900에 집중되어 굵기만으로 구분하려는 경향이 있음

### 3.2 장식이 내용보다 강함

현재 모바일 layer에는 다음 장식이 동시에 사용된다.

- 배경 radial gradient
- chat grid background
- glass/backdrop blur
- gradient avatar
- gradient user bubble
- 18~32px의 큰 radius
- 여러 겹의 shadow
- 거의 모든 상태를 pill로 표현

각 효과는 개별적으로 동작하지만 함께 사용되면서 Task 본문, Agent 답변, Plan 상태보다 chrome이 먼저 보인다.

### 3.3 모바일 상단에 제어가 과밀함

현재 구조는 다음을 conversation 진입 전후에 지속 노출한다.

- Termes header
- Hermes 연결 상태
- 검색
- Project chip 전체 목록
- 프로젝트 등록/수정/삭제
- Devices
- Task header actions
- Diff/Terminal/Files/Logs/Hermes filter

모바일에서는 자주 쓰는 행동과 상세 제어를 같은 깊이에 두지 않는다.

### 3.4 Task list가 카드 모음처럼 보임

Task row마다 큰 radius, avatar, status pill, event count가 들어가 대화 목록이 여러 개의 독립 카드처럼 보인다. 모바일 목록은 하나의 연속된 정보 surface로 읽혀야 한다.

### 3.5 Composer가 두 개의 개념을 동시에 처리함

현재 composer에는 Task title input과 message textarea가 항상 함께 있다. 기존 Task에 메시지를 보내는 상황에서도 새 Task title field가 노출되어 사용자가 현재 Task에 답하는지 새 Task를 만드는지 다시 해석해야 한다.

### 3.6 현재 CSS와 이전 CSS가 한 파일에 공존

현재 `.termesAliasShell` 계층 뒤에 사용되지 않는 `.ohShell` 계층이 대량으로 남아 있다. 새 theme token을 적용하기 전에 실제 selector 사용 여부를 확인하고 이전 계층을 제거해야 한다. 두 계층을 함께 유지한 채 override를 추가하지 않는다.

## 4. 최종 시각 방향: Termes Quiet Workbench

### 4.1 핵심 원칙

1. Conversation을 가장 조용한 surface로 만든다.
2. 여백과 글자 크기로 우선순위를 표현한다.
3. Agent 본문에는 기본적으로 bubble과 avatar를 사용하지 않는다.
4. 사용자의 prompt만 옅은 primary surface로 구분한다.
5. Plan과 실행 상태는 compact strip과 Activity row로 표현한다.
6. 자세한 기술 정보는 Activity detail에서 보여준다.
7. 상태 색은 강조가 필요한 작은 면적에만 사용한다.
8. Light/Dark 모두 같은 정보 위계와 component 구조를 사용한다.
9. 모든 Experience는 같은 semantic token과 저수준 primitive를 공유하되 화면 component와 navigation은 분리한다.
10. 특정 iPhone 모델을 기준으로 고정값을 만들지 않는다.

### 4.2 하지 않을 것

- Hermes 로고와 브랜드 색을 복제하지 않음
- decorative gradient, grid wallpaper, glow orb 사용 금지
- glass effect를 기본 surface로 사용하지 않음
- 모든 영역을 둥근 card로 만들지 않음
- meaningful text에 10px 또는 11px 사용 금지
- 상태를 색만으로 구분하지 않음
- Project/Task/Verification을 일반 chat metadata로 축소하지 않음
- 공통 화면을 복사한 모바일 source를 만들지 않으며 `experiences/mobile`의 전용 화면은 별도로 구현함
- light theme를 dark theme 색상의 단순 반전으로 생성하지 않음

## 5. Typography

### 5.1 Font family

```css
--font-sans:
  "Pretendard",
  -apple-system,
  BlinkMacSystemFont,
  "Apple SD Gothic Neo",
  Inter,
  "Segoe UI",
  sans-serif;

--font-mono:
  "JetBrains Mono",
  "SFMono-Regular",
  Consolas,
  monospace;
```

- 한글은 Pretendard 또는 OS Korean font를 우선한다.
- code, terminal, path, hash, ID에만 mono font를 사용한다.
- logo나 page title에 별도의 serif/display font를 사용하지 않는다.
- variable font를 도입하더라도 실제 사용하는 굵기는 400, 500, 600, 700로 제한한다.

### 5.2 Type scale

| Token | Mobile | Desktop | Weight | Line height | 사용처 |
| --- | --- | --- | --- | --- | --- |
| `display` | 32px | 36px | 700 | 1.12 | 빈 Task 첫 화면에서만 사용 |
| `page-title` | 20px | 22px | 650 | 1.30 | Settings/Activity detail title |
| `section-title` | 17px | 17px | 650 | 1.35 | Plan, Verification section |
| `conversation` | 15px | 15px | 400 | 1.62 | 사용자/Agent 본문 |
| `control` | 15px | 14px | 500 | 1.45 | 버튼, 입력, Task row title |
| `list-preview` | 13px | 13px | 400 | 1.45 | Task 미리보기, tool summary |
| `label` | 13px | 12px | 600 | 1.40 | field label, status label |
| `caption` | 12px | 12px | 500 | 1.40 | 시간, duration, 보조 정보 |
| `code` | 13px | 12px | 400 | 1.55 | code, terminal, path, log |

### 5.3 글자 규칙

- 모바일 input, textarea, select, rich composer는 무조건 16px 이상이다.
- Agent 답변은 15px/1.62를 유지하고 화면 폭에 따라 축소하지 않는다.
- Task title은 한 줄, preview는 최대 두 줄로 제한한다.
- 한글 본문에 과도한 letter-spacing을 사용하지 않는다.
- uppercase는 짧은 영문 상태 또는 코드에만 사용한다.
- metadata를 숨기기 위해 회색과 작은 크기를 동시에 과도하게 적용하지 않는다.
- 위험·승인·검증 정보는 최소 13px을 유지한다.

### 5.4 CSS token

```css
:root {
  --text-display-size: 2rem;
  --text-page-title-size: 1.25rem;
  --text-section-title-size: 1.0625rem;
  --text-conversation-size: 0.9375rem;
  --text-control-size: 0.9375rem;
  --text-list-preview-size: 0.8125rem;
  --text-label-size: 0.8125rem;
  --text-caption-size: 0.75rem;
  --text-code-size: 0.8125rem;

  --leading-display: 1.12;
  --leading-title: 1.3;
  --leading-conversation: 1.62;
  --leading-control: 1.45;
  --leading-code: 1.55;
}
```

## 6. Theme

### 6.1 Theme 구조

색상은 component selector에 직접 입력하지 않는다.

```text
Theme seed
  → semantic color token
  → component token
  → component CSS
```

예:

```text
--theme-primary
  → --signal-primary
  → --composer-send-background
  → .composerSendButton
```

### 6.2 Light theme

| Token | Value | 의미 |
| --- | --- | --- |
| `--surface-canvas` | `#F7F8FC` | app 외곽 배경 |
| `--surface-conversation` | `#FBFBFD` | 대화 배경 |
| `--surface-panel` | `#FFFFFF` | header, list, detail |
| `--surface-raised` | `#FFFFFF` | composer, modal |
| `--surface-subtle` | `#F1F3F8` | 선택·보조 영역 |
| `--text-primary` | `#17181B` | 본문·제목 |
| `--text-secondary` | `#555A64` | 보조 설명 |
| `--text-tertiary` | `#858B96` | 시간·비활성 metadata |
| `--stroke-subtle` | `#E8EAF0` | list divider |
| `--stroke-default` | `#D9DDE6` | input, composer |
| `--signal-primary` | `#2563EB` | 실행·focus·active |
| `--signal-primary-soft` | `#EAF0FF` | user prompt·active row |
| `--signal-success` | `#23845D` | 성공 |
| `--signal-success-soft` | `#E9F6F0` | 성공 배경 |
| `--signal-verification` | `#A66A13` | 검증·증거 |
| `--signal-verification-soft` | `#FFF4D8` | 검증 배경 |
| `--signal-warning` | `#B85C16` | 주의·승인 |
| `--signal-warning-soft` | `#FFF0E5` | 주의 배경 |
| `--signal-danger` | `#C33D53` | 실패·삭제 |
| `--signal-danger-soft` | `#FDECEF` | 실패 배경 |

### 6.3 Dark theme

| Token | Value |
| --- | --- |
| `--surface-canvas` | `#090B10` |
| `--surface-conversation` | `#0D1016` |
| `--surface-panel` | `#131720` |
| `--surface-raised` | `#191E28` |
| `--surface-subtle` | `#202632` |
| `--text-primary` | `#F4F6FA` |
| `--text-secondary` | `#B8BFCA` |
| `--text-tertiary` | `#7F8794` |
| `--stroke-subtle` | `#202631` |
| `--stroke-default` | `#303846` |
| `--signal-primary` | `#79A7FF` |
| `--signal-primary-soft` | `#17284A` |
| `--signal-success` | `#65C49D` |
| `--signal-success-soft` | `#153228` |
| `--signal-verification` | `#E2B35E` |
| `--signal-verification-soft` | `#352A16` |
| `--signal-warning` | `#F0A36B` |
| `--signal-warning-soft` | `#3A2418` |
| `--signal-danger` | `#F07C90` |
| `--signal-danger-soft` | `#3D1D26` |

### 6.4 Theme CSS 예시

```css
:root,
:root[data-theme="light"] {
  color-scheme: light;
  --surface-canvas: #f7f8fc;
  --surface-conversation: #fbfbfd;
  --surface-panel: #ffffff;
  --surface-raised: #ffffff;
  --surface-subtle: #f1f3f8;
  --text-primary: #17181b;
  --text-secondary: #555a64;
  --text-tertiary: #858b96;
  --stroke-subtle: #e8eaf0;
  --stroke-default: #d9dde6;
  --signal-primary: #2563eb;
  --signal-primary-soft: #eaf0ff;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --surface-canvas: #090b10;
  --surface-conversation: #0d1016;
  --surface-panel: #131720;
  --surface-raised: #191e28;
  --surface-subtle: #202632;
  --text-primary: #f4f6fa;
  --text-secondary: #b8bfca;
  --text-tertiary: #7f8794;
  --stroke-subtle: #202631;
  --stroke-default: #303846;
  --signal-primary: #79a7ff;
  --signal-primary-soft: #17284a;
}
```

### 6.5 Theme mode

지원 mode:

```text
light | dark | system
```

- 첫 사용은 `system`으로 생성한다.
- 사용자가 선택한 mode는 브라우저 profile 단위로 저장한다.
- `system`은 `prefers-color-scheme` 변경을 즉시 반영한다.
- 첫 paint 전에 inline bootstrap에서 저장된 mode를 적용한다.
- 저장 값은 versioned schema로 검증하고 migration한다.
- 알 수 없는 theme 이름이나 mode를 조용히 다른 값으로 바꾸지 않는다.
- 초기 release에는 `Termes Light`, `Termes Dark`만 제공한다.
- 사용자 theme import는 기본 token 체계와 contrast test가 안정된 뒤 추가한다.

### 6.6 Terminal과 code theme

Terminal ANSI palette는 일반 UI 색과 분리한다.

```ts
type TerminalPalette = {
  foreground: string;
  cursor: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};
```

Theme mode가 바뀌면 terminal instance에도 해당 palette를 명시적으로 전달한다.

## 7. Spacing·Radius·Shadow

### 7.1 Spacing scale

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
```

- 모바일 좌우 page inset: 기본 20px, 최소 16px
- Task list row 좌우: 16px
- Conversation turn 간격: 20px
- 같은 tool group 내부: 6px
- section 사이: 24px
- mobile detail section 사이: 32px

### 7.2 Radius

```css
--radius-control: 10px;
--radius-surface: 12px;
--radius-composer: 24px;
--radius-modal: 20px;
--radius-pill: 999px;
```

- status, count, filter, 원형 icon action에만 pill을 사용한다.
- Task list row와 설정 row에는 radius를 사용하지 않고 divider로 연결한다.
- mobile full-screen detail에는 외곽 radius를 사용하지 않는다.
- desktop pane의 외곽 radius는 최대 12px이다.

### 7.3 Shadow

```css
--shadow-composer: 0 12px 36px rgba(20, 27, 45, 0.1);
--shadow-modal: 0 24px 64px rgba(20, 27, 45, 0.18);
```

- 일반 panel과 row에는 shadow를 사용하지 않는다.
- composer와 modal/sheet만 elevation을 가진다.
- dark mode shadow는 검은색 불투명도를 높이지 않고 border 대비로 분리한다.

## 8. Mobile 정보 구조

```text
Project / Task List
  → Task Conversation
      → Activity Detail
      → Settings / Model Detail
```

820px 이하에서는 한 번에 하나의 주요 화면만 보여준다.

### 8.1 Project / Task List

Header:

- safe area 아래 56px
- 좌측 Termes wordmark 또는 현재 Project
- 우측 search와 새 Task
- Project 변경은 header switcher 또는 drawer 상단에서 수행

Task row:

- 최소 높이 72px
- 좌우 16px, 상하 12px
- title 15px/600 한 줄
- preview 13px 두 줄
- time/status 12px
- row 사이 `--stroke-subtle` divider
- active row는 `--signal-primary-soft`와 좌측 2px primary indicator
- avatar는 source가 사람/채널을 구분해야 할 때만 사용
- event count는 기본적으로 숨기고 Activity에서 확인

Footer:

- 고정 footer를 두지 않고 우측 하단 또는 header의 New Task action 사용
- 새로고침은 pull-to-refresh 또는 overflow menu에 배치

### 8.2 Task Conversation

Header:

- 높이 56px + safe area
- back/menu 44px
- Task title 15px/600 한 줄
- Project와 runtime 상태는 12px secondary text 한 줄
- 직접 action은 Activity와 overflow 두 개 이하
- rename, delete, settings, notification을 각각 icon으로 모두 노출하지 않음

Plan strip:

- header 아래 4px progress strip
- 진행 step이 없으면 표시하지 않음
- tap하면 Activity의 Plan section으로 이동
- blocked/needs-input이면 44px 높이의 action strip으로 확장

Conversation:

- 배경 `--surface-conversation`
- 좌우 20px, 상단 24px
- desktop 최대 본문 폭 760px
- Agent prose는 bubble 없는 평문
- 사용자 prompt는 우측 정렬, 최대 폭 88%
- 날짜 separator는 12px tertiary
- 마지막 message 아래 composer 실측 높이만큼 clearance 확보

### 8.3 Activity Detail

기존 Diff/Terminal/Files/Logs/Hermes filter bar를 모바일 React tree에 포함하지 않는다.

Activity entry:

- header의 layers icon
- 실행 중 tool row
- Plan strip
- approval/clarify action strip
- artifact/diff/verification link

Activity detail은 full-screen master/detail로 제공한다.

```text
Activity
  Plan
  Needs input
  Tools
  Changes summary
  Device status
  Artifacts
  Verification
  Connection status
```

각 section은 48px 이상 row로 표시한다. 모바일은 changed-file·device 상태 요약과 verification을 제공하며 full Diff, interactive Terminal, Device 제어와 raw runtime diagnostics는 제공하지 않는다.

### 8.4 Settings

- mobile에서는 overlay card가 아니라 full-screen page
- list row 최소 48px
- row 사이 thin divider
- title 20px
- detail 진입 후 명확한 back action
- input/select 44px, 16px
- 화면 하단 floating Done button을 기본 패턴으로 사용하지 않음
- 저장이 필요한 form은 sticky bottom action 또는 navigation save action 사용

## 9. Conversation Component 규칙

### 9.1 User message

```css
.userMessage {
  max-width: 88%;
  margin-left: auto;
  padding: 12px 16px;
  border: 1px solid color-mix(in srgb, var(--signal-primary) 8%, transparent);
  border-radius: var(--radius-surface);
  background: var(--signal-primary-soft);
  color: var(--text-primary);
  font-size: var(--text-conversation-size);
  line-height: var(--leading-conversation);
}
```

gradient를 사용하지 않는다. 사용자 이름은 일반 chat에서 반복 표시하지 않는다.

### 9.2 Agent message

- 기본적으로 avatar와 큰 container를 사용하지 않는다.
- 첫 part에만 Agent name, state, elapsed metadata를 표시한다.
- 본문은 plain Markdown surface에 렌더링한다.
- streaming caret 또는 작은 status text만 변화시킨다.
- message 전체에 반복 animation을 적용하지 않는다.

### 9.3 Reasoning

- 기본 접힘
- 44px disclosure row
- label 13px/600
- 진행 중에는 spinner와 `Reasoning` 상태 표시
- 펼친 본문은 13px/1.55 secondary text
- Agent 최종 답변보다 시각적으로 강하지 않게 구성

### 9.4 Tool group

Tool call을 여러 개의 큰 card로 만들지 않는다.

```text
Tools · 3
  ✓ Read styles.css               0.2s
  ✓ Update theme tokens           1.4s
  ● Run mobile visual test        running
```

- group outer surface: subtle background 또는 divider
- row 최소 40px desktop, 44px mobile
- tool name 13px/600
- summary 13px/400
- duration 12px
- args/result/diff는 disclosure detail
- 실패 row는 danger icon과 명시적 `Failed` label 표시

### 9.5 Approval

- conversation inline
- warning soft surface
- 요청 이유를 15px로 먼저 표시
- command/path/risk는 13px mono 또는 structured row
- 모바일 action은 세로 stack 또는 2열
- `한 번 승인`, `이번 세션`, `항상`, `거절`을 축약하지 않음
- 영구 승인은 별도 확인 step 제공

### 9.6 Clarify

- 질문 15px/600
- 선택 option 최소 44px
- option은 radio list 형태
- Other input 16px
- Continue/Skip의 의미를 명확히 표시
- keyboard A/B/C shortcut은 desktop에서만 보조 표시

### 9.7 Verification

- Tool/Artifact 결과와 가까운 위치에 배치
- verification gold를 사용하고 success green과 구분
- status, confidence, summary를 모두 표시
- confidence만 단독 badge로 표시하지 않음
- 자세한 증거는 Activity detail에서 확인

## 10. Composer

### 10.1 구조

```text
┌─────────────────────────────────┐
│ Ask or instruct anything…       │
│                                 │
│ ＋  Model · Reasoning       ◉ ↑ │
└─────────────────────────────────┘
```

- viewport 좌우 12px
- safe area + 12px 위
- 초기 최소 높이 76px
- 최대 높이 40dvh
- radius 24px
- border 1px
- input 16px/1.45
- send/stop 44px circle
- textarea 높이는 내용에 따라 자동 증가
- resize handle을 노출하지 않음
- composer 실측 높이를 CSS variable로 thread clearance에 반영

### 10.2 New Task와 Follow-up 분리

기존의 상시 title input을 제거한다.

New Task:

1. New Task action
2. Project 확인
3. prompt 입력
4. title은 첫 문장에서 자동 생성
5. 사용자가 원할 때 Optional details에서 수정

Follow-up:

- 현재 Task에 message, queue, steer 중 현재 capability에 맞는 동작 표시
- 실행 중이면 send button을 stop/steer 상태로 명확히 전환
- 새 Task title field를 보여주지 않음

## 11. Component token

```css
:root {
  --header-height: 56px;
  --tap-target-min: 44px;
  --mobile-page-inset: 20px;
  --mobile-page-inset-compact: 16px;

  --task-row-min-height: 72px;
  --settings-row-min-height: 48px;
  --activity-row-min-height: 44px;

  --conversation-max-width: 760px;
  --conversation-turn-gap: 20px;
  --tool-row-gap: 6px;

  --composer-mobile-inset: 12px;
  --composer-min-height: 76px;
  --composer-max-height: 40dvh;
  --composer-measured-height: 100px;

  --safe-top: env(safe-area-inset-top, 0px);
  --safe-right: env(safe-area-inset-right, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-left: env(safe-area-inset-left, 0px);
}
```

## 12. Responsive 기준

| 구간 | Layout |
| --- | --- |
| `< 820px` | Mobile Chat Experience |
| `820–1179px` 또는 coarse/no-hover 환경 | Tablet Review Experience |
| `≥ 1180px` + fine pointer + hover | Desktop Workstation Experience |

### Mobile

- header와 composer만 fixed/sticky
- body 자체는 scroll하지 않고 각 주요 view가 scroll owner
- VisualViewport로 keyboard inset 반영
- landscape에서도 입력과 주 action이 가려지지 않아야 함

### Tablet

- Task rail 280~320px
- conversation 최소 420px
- Activity는 필요할 때 overlay 또는 replacement pane

### Desktop

- Project/Task rail 300~340px
- conversation flexible, 본문 760px
- Activity 360~480px
- pane resize는 허용하되 최소 폭을 위반하지 않음

## 13. CSS·Component 파일 구조

```text
apps/web/src/
  app/
    providers/ThemeProvider.tsx
    theme-bootstrap.ts
  theme/
    tokens.css
    light.css
    dark.css
    typography.css
    motion.css
    terminal-palettes.ts
  components/ui/
    IconButton.tsx
    Button.tsx
    Surface.tsx
    StatusLabel.tsx
    ListRow.tsx
    FormField.tsx
  features/navigation/
    MobileHeader.tsx
    ProjectSwitcher.tsx
    TaskList.tsx
  features/conversation/
    ConversationView.tsx
    UserMessage.tsx
    AgentMessage.tsx
    ReasoningPart.tsx
    ToolGroup.tsx
    ApprovalCard.tsx
    ClarifyCard.tsx
    Composer.tsx
  features/activity/
    ActivityView.tsx
    PlanProgress.tsx
    VerificationRow.tsx
  styles/
    reset.css
    shell.css
    responsive.css
```

`styles.css` 하나에 모든 새 규칙을 계속 추가하지 않는다. 기능 component와 semantic token 경계를 먼저 만든다.

## 14. ThemeProvider 구현 계약

```ts
type ThemeMode = "light" | "dark" | "system";

type TermesThemeColors = {
  canvas: string;
  conversation: string;
  panel: string;
  raised: string;
  subtle: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  strokeSubtle: string;
  strokeDefault: string;
  primary: string;
  primarySoft: string;
  success: string;
  successSoft: string;
  verification: string;
  verificationSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
};
```

ThemeProvider 책임:

1. 저장된 versioned preference 읽기
2. system mode resolve
3. `data-theme`, `color-scheme`, semantic CSS variable 적용
4. media query 변경 구독
5. terminal palette 동기화
6. 첫 paint bootstrap과 동일한 값 사용
7. theme 변경 시 component rerender가 아니라 CSS variable 중심으로 반영

ThemeProvider가 담당하지 않는 것:

- radius와 layout 변경
- mobile/desktop component 전환
- 임의 contrast 합성
- 지원하지 않는 theme 자동 대체
- Hermes theme 이름이나 저장 key 재사용

## 15. 구현 순서

### Phase 0. 현재 UI 회귀 기준

- 390×844, 430×932, 820×1180, 1440×900 screenshot 저장
- Task list, conversation, Project drawer, Devices, Plan, Verification 기준 화면 확보
- 현재 사용 selector inventory 작성

완료 조건:

- UI 정리 전 기능과 layout 회귀를 비교할 기준이 있음

### Phase 1. Legacy CSS 제거

- JSX에서 사용하지 않는 `.ohShell` 계층 제거
- 중복 media query 제거
- literal color와 font-size inventory 생성
- 현재 mobile alias selector를 component 단위로 분류

완료 조건:

- 삭제한 selector가 실제 DOM에서 사용되지 않음을 E2E로 확인
- 같은 element를 두 CSS 계층이 동시에 제어하지 않음

### Phase 2. Token과 ThemeProvider

- typography, spacing, radius, surface, semantic status token 추가
- Termes Light/Dark 구현
- system mode와 pre-paint bootstrap 구현
- terminal palette 연결

완료 조건:

- 주요 component에 hex/rgb literal 없음
- light/dark 전환 시 layout shift 없음
- 첫 paint theme flash 없음

### Phase 3. Mobile shell

- Project chip toolbar를 Project switcher로 변경
- header action을 Activity와 overflow로 축소
- list/chat/activity 단일 화면 navigation
- safe area와 VisualViewport 적용

완료 조건:

- 390px 폭에서 header action 겹침 없음
- 특정 device 높이 상수 없음

### Phase 4. Conversation과 Composer

- Agent plain prose
- subtle user message
- structured reasoning/tool/approval/clarify
- floating measured composer
- New Task와 Follow-up composer 분리

완료 조건:

- meaningful mobile text 최소 크기 준수
- iOS input focus zoom 없음
- keyboard가 composer와 마지막 message를 가리지 않음

### Phase 5. Activity와 Settings

- Plan strip
- Activity master/detail
- Verification과 Artifact 연결
- full-screen mobile settings
- operator diagnostics 분리

완료 조건:

- 기존 Diff/Terminal/Files/Logs/Hermes 기능에 도달 가능
- conversation chrome은 단순하게 유지

### Phase 6. Mobile 검증 Gate

- 모바일 제한 기능이 React tree에 포함되지 않는지 확인
- 실제 Account/OAuth/Hermes Task로 mobile E2E 수행
- Tablet과 Desktop은 contract와 lazy import 경계만 유지

완료 조건:

- Mobile Chat Experience 완료 정의 통과
- Tablet/Desktop UI 구현은 후속 Gate로 남음

## 16. 검증 기준

### Typography

- 모바일 의미 정보에 10px/11px 없음
- input/select/textarea 16px 이상
- conversation 15px/1.62
- long Korean/English/path가 겹치지 않음

### Touch

- 모든 주 action 최소 44×44px
- Task/settings/activity row 최소 높이 준수
- destructive action이 primary action과 붙어 있지 않음

### Theme

- Light/Dark WCAG AA
- status에 label/icon 포함
- system mode 실시간 반영
- first-paint flash 없음
- code/diff/terminal palette 검증

### Layout

- 390×844
- 430×932
- tablet 820×1180
- desktop 1440×900
- portrait/landscape
- safe area가 있는 viewport
- keyboard open/close

### Product 기능

- Project 변경
- Task 생성/선택
- Hermes streaming
- Plan progress
- Tool progress/result
- Approval/Clarify
- Device command
- Artifact/Diff
- Verification
- Runtime diagnostics

## 17. 완료 정의

다음이 모두 만족되어야 UI 정리가 완료된 것으로 본다.

1. 모바일 첫 화면에서 대화와 composer가 가장 먼저 보인다.
2. Project/Task 문맥은 유지되지만 대화보다 강하지 않다.
3. Agent 답변이 장식 card가 아니라 읽기 좋은 본문으로 보인다.
4. 사용자 prompt는 옅은 Termes primary surface로 구분된다.
5. Plan은 compact progress로 보이고 Activity detail로 이동할 수 있다.
6. Tool, Approval, Clarify, Verification이 구조화되어 표시된다.
7. meaningful mobile text가 12px 미만으로 내려가지 않는다.
8. 모든 입력은 16px 이상이며 모든 주 action은 44px 이상이다.
9. Light/Dark/System theme가 first-paint flash 없이 동작한다.
10. decorative gradient, grid wallpaper, glass-heavy chrome이 제거된다.
11. legacy `.ohShell` CSS가 제거된다.
12. 모든 Experience가 같은 domain contract와 token을 사용하고 각 화면 component는 독립적으로 구현된다.
13. Hermes의 깔끔함을 흡수하되 Termes의 Project·Task·Plan·Device·Verification 정체성이 유지된다.
