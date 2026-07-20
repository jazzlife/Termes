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
COPY packages/eventing/package.json packages/eventing/package.json
COPY packages/eventing/tsconfig.json packages/eventing/tsconfig.json
COPY packages/eventing/src packages/eventing/src
COPY services/hermes-projector/package.json services/hermes-projector/package.json
COPY services/hermes-projector/tsconfig.json services/hermes-projector/tsconfig.json
COPY services/hermes-projector/src services/hermes-projector/src

RUN pnpm install --filter @termes/hermes-projector... --frozen-lockfile
RUN pnpm --filter @termes/hermes-projector build

FROM node:22-alpine
WORKDIR /app/services/hermes-projector
ENV NODE_ENV=production
COPY --from=build /app/services/hermes-projector/dist dist
EXPOSE 8080
CMD ["node", "dist/main.cjs"]
