# ---------------------------------------------------------------------------
# Base — install deps and build the library
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base

WORKDIR /workspace

# Enable corepack so the packageManager field in package.json is honoured
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Build the library; the fixture app imports from dist/
RUN pnpm build

# ---------------------------------------------------------------------------
# fcgi-app — runs the FastCGI fixture application
# ---------------------------------------------------------------------------
FROM base AS fcgi-app

EXPOSE 9000
CMD ["node", "test/e2e/fixtures/app.mjs"]

# ---------------------------------------------------------------------------
# e2e-test — runs the vitest E2E suite inside the compose network
# ---------------------------------------------------------------------------
FROM base AS e2e-test

CMD ["pnpm", "vitest", "run", "--config", "test/e2e/vitest.config.ts"]
