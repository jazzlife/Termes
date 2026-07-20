FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY services/device-gateway/package.json services/device-gateway/package.json
COPY services/device-gateway/tsconfig.json services/device-gateway/tsconfig.json
COPY services/device-gateway/src services/device-gateway/src

RUN pnpm install --filter @termes/device-gateway... --frozen-lockfile
RUN pnpm --filter @termes/device-gateway build

FROM node:22-alpine

WORKDIR /app/services/device-gateway
ENV NODE_ENV=production
RUN apk add --no-cache openssh-client

COPY --from=build /app/services/device-gateway/dist dist
EXPOSE 8080
CMD ["node", "dist/main.cjs"]
