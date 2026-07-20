FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY packages/hermes-compat/package.json packages/hermes-compat/package.json
COPY packages/hermes-compat/tsconfig.json packages/hermes-compat/tsconfig.json
COPY packages/hermes-compat/src packages/hermes-compat/src
COPY apps/web/package.json apps/web/package.json
COPY apps/web/tsconfig.json apps/web/tsconfig.json
COPY apps/web/vite.config.ts apps/web/vite.config.ts
COPY apps/web/index.html apps/web/index.html
COPY apps/web/public apps/web/public
COPY apps/web/src apps/web/src

RUN pnpm install --filter @termes/web... --frozen-lockfile
RUN pnpm --filter @termes/web build

FROM nginx:1.27-alpine

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
