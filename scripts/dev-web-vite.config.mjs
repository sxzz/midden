import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { allowedRequest } from "./dev-web.mjs";

const webRoot = fileURLToPath(new URL("../web/", import.meta.url));
const webRequire = createRequire(resolve(webRoot, "package.json"));
const { loadConfigFromFile, mergeConfig } = await import(
  pathToFileURL(webRequire.resolve("vite")).href
);

export default async function (env) {
  const {
    MIDDEN_PREVIEW_SESSION: session,
    MIDDEN_PREVIEW_ORIGIN: origin,
    MIDDEN_PREVIEW_CORE: core,
    MIDDEN_PREVIEW_CONFIG: config,
  } = process.env;
  if (!session || !origin || !core || !config)
    throw new Error("Start this config with pnpm dev:web");
  const loaded = await loadConfigFromFile(env, config, webRoot);
  if (!loaded) throw new Error("Could not load the frontend Vite config");
  return mergeConfig(loaded.config, {
    plugins: [
      {
        name: "preview-access",
        configureServer(vite) {
          // Also reload when the underlying frontend config changes.
          vite.watcher.add(loaded.dependencies);
          vite.watcher.on("change", (file) => {
            if (loaded.dependencies.includes(file)) void vite.restart();
          });
          vite.middlewares.use((req, res, next) => {
            if (!allowedRequest(req, vite.config.server.host)) {
              res.statusCode = 403;
              res.end("Preview requests must be same-origin");
              return;
            }
            next();
          });
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      cors: false,
      proxy: {
        "/v1": {
          target: core,
          // Keep credentials out of resolved config/debug logs and the client.
          configure(proxy) {
            proxy.on("proxyReq", (request) => {
              request.setHeader("Cookie", `__Host-midden=${session}`);
              request.setHeader("Origin", origin);
            });
          },
        },
      },
    },
  });
}
