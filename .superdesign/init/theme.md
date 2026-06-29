# Theme

## Framework

- React 18
- Vite
- Vanilla CSS
- `lucide-react` icons

## Current CSS Source

Theme and component styles are defined in `apps/web/src/styles.css`.

```css
:root {
  color: #18212f;
  background: #eef3f0;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}
```

## Current Tokens

- Font: Inter/system sans
- Radius: 6px, 8px, pill for status badges
- Background: `#eef3f0`
- Sidebar: `#132019`
- Accent: `#1b6b43`, `#8bd86f`
- Surface: `#ffffff`
- Border: `#d8e0dc`, `#e5ebe7`

The OpenHands-style redesign should move to a dense dark workbench palette while keeping Termes identity:

- App background: near-black neutral
- Panels: dark graphite
- Rail: black
- Accent: muted green/gold for active state and primary action
- Text: high contrast white/off-white, muted gray for metadata
