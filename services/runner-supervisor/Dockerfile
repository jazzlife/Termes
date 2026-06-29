FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY services/runner-supervisor/package.json services/runner-supervisor/package.json
COPY services/runner-supervisor/tsconfig.json services/runner-supervisor/tsconfig.json
COPY services/runner-supervisor/src services/runner-supervisor/src

RUN pnpm install --filter @termes/runner-supervisor... --frozen-lockfile
RUN pnpm --filter @termes/runner-supervisor build

FROM node:22-alpine

WORKDIR /app/services/runner-supervisor
ENV NODE_ENV=production

COPY --from=build /app/services/runner-supervisor/dist dist
EXPOSE 8080
CMD ["node", "dist/main.cjs"]
