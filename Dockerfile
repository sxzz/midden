# Node's version is written once, in devEngines in package.json; CI reads it
# from there and passes it in. Without it the image reference is invalid and
# the build stops. Both stages use the same Alpine release, so the Node binary
# copied into the runtime finds the libraries it was built against.
ARG NODE_VERSION
ARG ALPINE_VERSION=3.24

# Build: install, build Atmosphere and the web app, then copy out the server
# with only its production dependencies. The output is JavaScript, so it is
# built on the builder's own platform whatever the target.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g "pnpm@$(node -p 'require("./package.json").devEngines.packageManager.version')"
COPY server/package.json server/
COPY shared/package.json shared/
COPY third_party/atmosphere/package.json third_party/atmosphere/
COPY web/package.json web/
# Sources are not copied yet; the build below builds Atmosphere.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
# `deploy` installs the server's production dependencies on their own, with
# the workspace packages it uses (Atmosphere, shared) copied in: none of the
# web app's dependencies end up in the image.
RUN pnpm build && pnpm --filter @midden/server deploy --prod /out/server

FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node

# Run: Node executes the server's TypeScript directly. Only the node binary
# is taken from the Node image, leaving out npm, Yarn and Corepack. The node
# user keeps the official image's IDs, which own existing data volumes.
FROM alpine:${ALPINE_VERSION}
RUN apk add --no-cache ffmpeg libstdc++ && \
  addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /srv
COPY --from=build /out/server server
COPY --from=build /src/web/dist web/dist
# The agent API's guide, served at /agent.md (server/src/agent/doc.ts).
COPY docs/agent.md docs/agent.md
COPY LICENSE /usr/share/licenses/midden/LICENSE
ENV DATA_DIR=/data WEB_DIR=/srv/web/dist NODE_ENV=production
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME /data
# Last, so a new commit does not invalidate the layers above.
ARG VCS_REF=dev
ENV BUILD_REVISION=$VCS_REF
CMD ["node", "server/src/main.ts"]
