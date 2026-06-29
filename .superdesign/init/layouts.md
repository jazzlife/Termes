# Layouts

현재 앱은 별도 layout component 없이 `App` 컴포넌트가 전체 shell을 렌더링합니다.

## App Shell

- Source: `apps/web/src/main.tsx`
- Description: 좌측 sidebar, 상단 topbar, task composer, task list, event stream을 렌더링하는 단일 페이지 shell입니다.

```tsx
// Full layout source:
// apps/web/src/main.tsx
```

## Global Layout Styles

- Source: `apps/web/src/styles.css`
- Description: `.shell`, `.sidebar`, `.workspace`, `.mainGrid`, `.panel` 등 전체 레이아웃 스타일입니다.

```css
/* Full layout stylesheet:
   apps/web/src/styles.css */
```
