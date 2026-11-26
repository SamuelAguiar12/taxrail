FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@10

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/tax-engine ./packages/tax-engine
COPY packages/execution ./packages/execution
COPY packages/mcp-cli ./packages/mcp-cli

RUN pnpm install --no-frozen-lockfile --filter taxrail-mcp... && pnpm --filter taxrail-mcp build

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/packages/mcp-cli/package.json ./package.json
COPY --from=builder /app/packages/mcp-cli/dist/index.js ./dist/index.js

RUN npm install --omit=dev --ignore-scripts

ENTRYPOINT ["node", "/app/dist/index.js"]
