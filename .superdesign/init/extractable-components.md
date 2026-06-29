# Extractable Components

Current UI has no extracted React layout components. The redesign should introduce or preserve these logical component boundaries inside `apps/web/src/main.tsx` first, then they can be extracted later.

## AppRail

- Source: `apps/web/src/main.tsx`
- Category: layout
- Description: Thin OpenHands-style left activity rail with brand, new task, project/task navigation, runtime, and user controls.
- Extractable props: activeItem, taskCount
- Hardcoded: Termes logo mark, Lucide icons, navigation labels

## ConversationSidebar

- Source: `apps/web/src/main.tsx`
- Category: layout
- Description: Project and task conversation list next to the rail.
- Extractable props: activeProjectId, selectedTaskId
- Hardcoded: Section labels, compact filters

## AgentWorkspace

- Source: `apps/web/src/main.tsx`
- Category: layout
- Description: Main task conversation and workbench area.
- Extractable props: selectedTaskId, activeWorkbenchTab
- Hardcoded: Chat/task composition, event rendering, workbench tabs
