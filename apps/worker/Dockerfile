FROM node:20-alpine
WORKDIR /app

# workspace root
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
# shared + worker only
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
RUN pnpm -r install --frozen-lockfile
RUN pnpm -C packages/shared build
RUN pnpm -C apps/worker build

CMD ["node", "apps/worker/dist/worker.js"]
