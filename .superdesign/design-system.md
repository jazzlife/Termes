# Termes Multi-Experience Design System

## Product Context

Termes is a Project First AI development platform. The conversation is the primary work surface, while Task, Plan, Tool, Device, Artifact, Approval, and Verification remain visible as structured operational state. The mobile experience should feel as quiet and readable as Hermes Mobile without copying Hermes branding.

Termes uses one authenticated data/runtime system with three intentionally separate presentation experiences:

- Mobile Chat: conversation, immediate input, progress summary, approval and verification.
- Tablet Review: readable source and diff review without IDE-grade mutation controls.
- Desktop Workstation: IDE-grade source editing, terminal/process control and authorized system operation.

The experiences share domain contracts, AppKernel state, realtime projection, semantic tokens and low-level UI primitives. Screen components, navigation and feature composition are experience-specific and are not responsive copies of one shared DOM tree.

## Visual Direction

- Light-first, calm, single-color surfaces.
- No decorative gradients, grid backgrounds, glow orbs, glass-heavy chrome, or ornamental shadows.
- Use whitespace and typography before borders or colored containers.
- Agent prose is plain on the page. User prompts may use a subtle tinted bubble.
- Operational data is compact but never reduces mobile text below its defined readable floor.
- Project and Task context stays visible but secondary to the active conversation.

## Typography

- Sans: `Pretendard`, `-apple-system`, `BlinkMacSystemFont`, `Apple SD Gothic Neo`, `Inter`, `Segoe UI`, sans-serif.
- Mono: `JetBrains Mono`, `SFMono-Regular`, `Consolas`, monospace.
- Mobile root/input: 16px to prevent iOS focus zoom.
- Display: 32px / 1.12 / 700, only for a true empty state.
- Page title: 20px / 1.3 / 650.
- Section title: 17px / 1.35 / 650.
- Conversation body: 15px / 1.62 / 400.
- Control and list body: 15px / 1.45 / 500.
- Label: 13px / 1.4 / 600.
- Caption and metadata: 12px / 1.4 / 500.
- Code/log: 13px / 1.55 / 400.
- Do not use 10px or 11px for meaningful mobile information.
- Korean text uses normal word breaking. IDs and paths use `overflow-wrap:anywhere`.

## Light Theme

- Canvas: `#F7F8FC`
- Main conversation: `#FBFBFD`
- Surface: `#FFFFFF`
- Raised surface: `#FFFFFF`
- Subtle surface: `#F1F3F8`
- Text primary: `#17181B`
- Text secondary: `#555A64`
- Text tertiary: `#858B96`
- Border subtle: `#E8EAF0`
- Border default: `#D9DDE6`
- Primary signal: `#2563EB`
- Primary soft: `#EAF0FF`
- Primary foreground: `#FFFFFF`
- Success: `#23845D`
- Success soft: `#E9F6F0`
- Verification: `#A66A13`
- Verification soft: `#FFF4D8`
- Warning: `#B85C16`
- Warning soft: `#FFF0E5`
- Danger: `#C33D53`
- Danger soft: `#FDECEF`
- Focus ring: `rgba(37, 99, 235, 0.28)`

## Dark Theme

- Canvas: `#090B10`
- Main conversation: `#0D1016`
- Surface: `#131720`
- Raised surface: `#191E28`
- Subtle surface: `#202632`
- Text primary: `#F4F6FA`
- Text secondary: `#B8BFCA`
- Text tertiary: `#7F8794`
- Border subtle: `#202631`
- Border default: `#303846`
- Primary signal: `#79A7FF`
- Primary soft: `#17284A`
- Primary foreground: `#07101F`
- Success: `#65C49D`
- Success soft: `#153228`
- Verification: `#E2B35E`
- Verification soft: `#352A16`
- Warning: `#F0A36B`
- Warning soft: `#3A2418`
- Danger: `#F07C90`
- Danger soft: `#3D1D26`
- Focus ring: `rgba(121, 167, 255, 0.34)`

## Spacing and Geometry

- Base spacing unit: 4px.
- Mobile page inset: 20px; compact edge minimum: 16px.
- Vertical content rhythm: 8, 12, 16, 24, 32px.
- Conversation turn gap: 20px.
- Related tool rows inside a turn: 6px.
- Header height: 56px plus safe area.
- All tap targets: minimum 44×44px.
- Input/select minimum height: 44px.
- Standard radius: 12px.
- Compact control radius: 10px.
- Composer radius: 24px mobile, 20px desktop.
- Pills use full radius only for status, count, filter, or a single primary circular action.
- Do not round every panel into a floating card.

## Elevation

- Most surfaces use a subtle border and no shadow.
- Composer: `0 12px 36px rgba(20, 27, 45, 0.10)` in light mode.
- Full-screen mobile detail has no outer radius or shadow.
- Modal/sheet only: `0 24px 64px rgba(20, 27, 45, 0.18)`.

## Mobile Layout

- Flow: Project/Task list → Conversation → Activity detail.
- One primary screen at a time below 820px.
- The conversation background is visually quiet and full bleed.
- Safe area uses `env(safe-area-inset-*)`; keyboard uses VisualViewport.
- Header exposes back/menu, one-line Task title, and at most two direct actions.
- Secondary actions live in a menu or Activity detail.
- Horizontal project chips are replaced by a single Project switcher row or drawer section.
- Plan appears as a compact progress strip, not a permanent large card.
- Verification appears next to the artifact/tool result it verifies and in Activity detail.
- Composer floats above the safe area and its measured height controls final-message clearance.
- Mobile renders a dedicated React tree. Desktop and tablet workspaces are not mounted and hidden with CSS.
- Mobile Activity exposes Plan, needs-input, specialist/tool summaries, changed-file summary, artifacts and verification.
- Mobile does not expose a full diff viewer, file editor, interactive terminal, raw logs, device registration/command controls, runtime operator diagnostics, or the raw Hermes JSON-RPC console.
- Project registration and destructive workspace administration are not persistent mobile chrome. Project and Task selection remain first-class.

## Conversation

- Content width: 760px desktop, full available width minus mobile insets.
- Agent message: no avatar bubble gradient and no large container; name/status metadata then readable prose.
- User message: right aligned, max-width 88%, `Primary soft` background, subtle border.
- Message body: 15px with 1.62 line-height; Markdown paragraph gap 10px.
- Reasoning: collapsed row by default, using tertiary text and a disclosure affordance.
- Tool group: quiet grouped rows with name, status, duration, and summary; technical details expand on demand.
- Approval/Clarify: inline structured card with plain-language prompt and full-width mobile actions.
- Streaming uses a caret/status change; do not animate the entire message.

## Composer

- Floating surface with one hairline border and soft shadow.
- Mobile width: viewport minus 24px; bottom: safe area plus 12px.
- Rich input font: 16px / 1.45.
- Initial height: 76px; expands to a maximum of 40vh.
- First row is the input. Bottom row contains attach, model/reasoning summary, voice, and primary send/stop.
- Primary send/stop is 44px circular.
- New Task title is not a permanent second input; expose it through a New Task flow or optional details control.
- Disabled actions retain shape and use tertiary text without low-opacity unreadability.

## Lists and Settings

- Task rows are a single list separated by subtle dividers, not detached rounded cards.
- Task title: 15px semibold; preview: 13px, maximum two lines; status/time: 12px.
- Active Task uses a soft primary surface and a 2px leading indicator.
- Mobile settings use full-width rows with 48px minimum height and dividers.
- Detail pages replace the list and include a clear back action.
- Forms use 16px controls and 12px labels; helper/error text is 13px.

## Experience Boundaries

- Mobile, Tablet and Desktop have separate screen and navigation components.
- They share semantic tokens, accessibility primitives, domain models and AppKernel projections.
- Tablet and Desktop may reuse headless domain components, but they must not import Mobile screen composition.
- Experience-specific code is loaded dynamically so the Mobile initial bundle does not include editor, terminal or full-diff implementations.
- Effective UI capability is the intersection of upstream support, account policy, Project/Task context and the selected Experience policy.
- Experience policy changes visibility and interaction scope only. Server authorization remains the final enforcement boundary.

## Mobile First Delivery Gate

The first delivery implements only Mobile Chat. Tablet Review and Desktop Workstation are architectural contracts until their later delivery gates.

Mobile must include:

- account session and shared OpenAI OAuth status;
- Project switcher, Task list/search/selection;
- distinct New Task and Follow-up flows;
- Markdown and live Hermes text projection;
- collapsed reasoning, grouped tool summary, routing and specialist summary;
- Approval, Clarify, Sudo and Secret interactions;
- compact Plan progress, changes summary, artifacts and verification;
- Light, Dark and System theme;
- safe-area and VisualViewport keyboard handling.

## Motion and Accessibility

- Motion durations: 120ms press, 160ms color, 180–220ms pane transition.
- Press scale: 0.98; never scale large surfaces.
- Honor `prefers-reduced-motion`.
- Focus is always visible with a 2px ring.
- Text and controls must meet WCAG AA contrast.
- Color is never the only status indicator; always include label or icon.
