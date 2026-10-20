# Take It Over! — server + built PWA in one image.
#   docker compose up            (see docker-compose.yml and README.md)
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/lab/package.json packages/lab/
# Behind a TLS-intercepting (corporate) proxy, pass its CA as a build secret:
#   docker build --secret id=extra_ca,src=/path/to/ca.pem .
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile

FROM deps AS app
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
# Type-checking already runs in CI; the image only bundles (≈650 MB peak RAM, capped).
RUN NODE_OPTIONS=--max-old-space-size=1024 pnpm --filter @tio/web exec vite build
ENV NODE_ENV=production \
    PORT=8080 \
    TIO_WEB_DIST=/app/packages/web/dist
EXPOSE 8080
WORKDIR /app/packages/server
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
