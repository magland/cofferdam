FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts/build-info.js ./scripts/
# The build stamp the web UI shows at the foot of every page. This context has
# no .git (see .dockerignore), so the commit is handed in instead of read, and
# .github/workflows/image.yml is what hands it in. A build without it is still
# a build: the stamp then carries the date alone.
ARG FEORGE_BUILD_COMMIT=""
ARG FEORGE_BUILD_DATE=""
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir /vault && chown node:node /vault
USER node
VOLUME /vault
EXPOSE 3000
CMD ["node", "dist/index.js", "serve", "/vault", "--host", "0.0.0.0", "--port", "3000"]
