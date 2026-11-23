# Build: install, build Atmosphere and the web app, then drop dev dependencies.
FROM node:26.13.1-alpine AS build
RUN npm install -g pnpm@12.23.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY shared/package.json shared/
COPY third_party/atmosphere/package.json third_party/atmosphere/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

# Run: Node executes the server's TypeScript directly.
FROM node:26.13.1-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /srv
COPY --from=build /src/package.json /src/pnpm-workspace.yaml ./
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/server server
COPY --from=build /src/shared shared
COPY --from=build /src/third_party/atmosphere/package.json third_party/atmosphere/
COPY --from=build /src/third_party/atmosphere/dist third_party/atmosphere/dist
COPY --from=build /src/third_party/atmosphere/node_modules third_party/atmosphere/node_modules
COPY --from=build /src/web/dist web/dist
COPY LICENSE /usr/share/licenses/midden/LICENSE
ENV DATA_DIR=/data WEB_DIR=/srv/web/dist NODE_ENV=production
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME /data
CMD ["node", "server/src/main.ts"]
