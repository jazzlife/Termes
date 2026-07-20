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
ARG CODEX_VERSION=0.144.1
ARG CODEX_INSTALL_REVISION=2
RUN npm install --global "@openai/codex@${CODEX_VERSION}" && npm cache clean --force
RUN test -s /usr/local/lib/node_modules/@openai/codex/package.json && \
    find /usr/local/lib/node_modules/@openai/codex/node_modules/@openai -type f -name codex -size +0c | grep -q . && \
    test "$(codex --version)" = "codex-cli ${CODEX_VERSION}" && \
    test -n "${CODEX_INSTALL_REVISION}"

COPY --from=build /app/services/hermes-manager/dist dist
EXPOSE 8080
CMD ["node", "dist/main.cjs"]
