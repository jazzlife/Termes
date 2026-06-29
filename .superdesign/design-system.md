# Termes Design System

## Product Context

Termes is an internal AI development platform. The primary desktop/tablet experience is an agent workbench: create tasks, steer runs, watch event streams, inspect runtime state, and review planned diffs.

## Layout Direction

Use an OpenHands-style workbench composition:

- Thin left activity rail for global actions
- Secondary sidebar for projects, tasks, and repository/file context
- Central conversation-oriented task workspace
- Right inspector for runtime, events, and agent status
- Bottom or embedded tab strip for diff, terminal, files, and logs

## Visual Tokens

- Font: Inter/system sans
- Base background: `#060708`
- Rail background: `#050607`
- Sidebar background: `#101215`
- Panel background: `#171a1f`
- Raised surface: `#20242b`
- Border: `#303640`
- Text primary: `#f3f5f7`
- Text secondary: `#b5bcc7`
- Text muted: `#777f8b`
- Primary accent: `#d8c778`
- Success accent: `#65d18c`
- Warning accent: `#e5b95f`
- Danger accent: `#ef766d`
- Radius: 6px for buttons and panels; avoid overly rounded cards
- Spacing: dense workbench spacing, 8px base grid

## Component Rules

- Buttons use icons where possible.
- Panels are tool surfaces, not decorative cards.
- Text must not overflow in desktop or tablet widths.
- Desktop target: 1440px.
- Tablet target: 1024px.
- No marketing hero.
- No decorative gradient/orb backgrounds.
