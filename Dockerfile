FROM node:20-alpine AS build
RUN apk add --no-cache python3 build-base
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npx tsc
RUN npm prune --omit=dev && rm -rf /root/.npm /root/.cache

FROM node:20-alpine
RUN apk add --no-cache python3 build-base && \
    addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
RUN mkdir -p /app/data && chown app:app /app/data
USER app
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
