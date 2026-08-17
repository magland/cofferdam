FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
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
