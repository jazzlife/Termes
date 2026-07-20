FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY packages/eventing/package.json packages/eventing/package.json
COPY packages/eventing/tsconfig.json packages/eventing/tsconfig.json
COPY packages/eventing/src packages/eventing/src
COPY apps/api/package.json apps/api/package.json
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src

RUN pnpm install --filter @termes/api... --frozen-lockfile
RUN pnpm --filter @termes/api build

FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache git

COPY --from=build /app/apps/api/dist apps/api/dist
COPY infra/db/migrations infra/db/migrations

WORKDIR /app/apps/api
EXPOSE 8080
CMD ["node", "dist/server.cjs"]
