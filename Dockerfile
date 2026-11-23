# Build: install, build Atmosphere and the web app, then copy out the server
# with only its production dependencies. The output is JavaScript, so it is
# built once on the builder's own platform rather than under emulation for
# each target.
FROM --platform=$BUILDPLATFORM node:26.13.1-alpine AS build
RUN npm install -g pnpm@12.23.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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

# Run: Node executes the server's TypeScript directly.
FROM node:26.13.1-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /srv
COPY --from=build /out/server server
COPY --from=build /src/web/dist web/dist
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
