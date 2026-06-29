FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY services/orchestrator/package.json services/orchestrator/package.json
COPY services/orchestrator/tsconfig.json services/orchestrator/tsconfig.json
COPY services/orchestrator/src services/orchestrator/src

RUN pnpm install --filter @termes/orchestrator... --frozen-lockfile
RUN pnpm --filter @termes/orchestrator build

FROM node:22-alpine

WORKDIR /app/services/orchestrator
ENV NODE_ENV=production

COPY --from=build /app/services/orchestrator/dist dist
EXPOSE 8080
CMD ["node", "dist/main.cjs"]
