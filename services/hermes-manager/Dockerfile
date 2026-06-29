FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY services/hermes-manager/package.json services/hermes-manager/package.json
COPY services/hermes-manager/tsconfig.json services/hermes-manager/tsconfig.json
COPY services/hermes-manager/src services/hermes-manager/src

RUN pnpm install --filter @termes/hermes-manager... --frozen-lockfile
RUN pnpm --filter @termes/hermes-manager build

FROM node:22-alpine

WORKDIR /app/services/hermes-manager
ENV NODE_ENV=production

COPY --from=build /app/services/hermes-manager/dist dist
EXPOSE 8080
CMD ["node", "dist/main.cjs"]
