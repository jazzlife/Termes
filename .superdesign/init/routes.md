# Routes

Termes Web은 Vite React SPA입니다. 별도 router는 없고 `/` 하나의 entry page를 `apps/web/src/main.tsx`에서 렌더링합니다.

## Route Map

| URL | Entry | Layout |
| --- | --- | --- |
| `/` | `apps/web/src/main.tsx` | Inline App shell |

## Vite Entry

- HTML: `apps/web/index.html`
- Script: `/src/main.tsx`

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Termes</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```
