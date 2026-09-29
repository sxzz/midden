#!/usr/bin/env node
// Local-only frontend preview against an already running core/Postgres stack.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { isIP } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export function localURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "--core must be a loopback HTTP origin, e.g. http://127.0.0.1:8080",
    );
  return url.origin;
}

export function splitArguments(args) {
  const boundary = args.indexOf("--");
  return boundary < 0
    ? { own: args, vite: [] }
    : { own: args.slice(0, boundary), vite: args.slice(boundary + 1) };
}

// The wrapper config adds authentication while loading any user-selected config.
// All other arguments are parsed by Vite itself, including optional --host.
export function previewArguments(args) {
  const forwarded = [];
  let config;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" || args[i] === "-c") {
      config = args[++i];
      if (!config || config.startsWith("-"))
        throw new Error("Missing Vite config path");
    } else if (args[i].startsWith("--config=")) {
      config = args[i].slice("--config=".length);
      if (!config) throw new Error("Missing Vite config path");
    } else forwarded.push(args[i]);
  }
  return { forwarded, config };
}

export function allowedRequest(req, host = "127.0.0.1") {
  try {
    const url = new URL(`http://${req.headers.host}`);
    const origin = url.origin;
    if (
      !req.headers.host ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const allInterfaces = host === true || host === "0.0.0.0" || host === "::";
    if (
      !["127.0.0.1", "localhost", "::1"].includes(hostname) &&
      !(allInterfaces && isIP(hostname)) &&
      hostname !== host
    )
      return false;
    return (
      (!req.headers.origin || req.headers.origin === origin) &&
      (!req.headers["sec-fetch-site"] ||
        ["same-origin", "none"].includes(req.headers["sec-fetch-site"]))
    );
  } catch {
    return false;
  }
}

async function main() {
  const args = splitArguments(process.argv.slice(2));
  const { values } = parseArgs({
    args: args.own,
    options: {
      help: { type: "boolean", short: "h" },
      port: { type: "string", default: "5174" },
      core: { type: "string", default: "http://127.0.0.1:8080" },
      postgres: { type: "string" },
      tenant: { type: "string" },
    },
  });
  if (values.help) {
    console.log(`Usage: pnpm dev:web [--port 5174] [--core http://127.0.0.1:8080]
                    [--postgres CONTAINER] [--tenant UUID] [-- VITE_ARGS...]

Examples: pnpm dev:web -- --host
          pnpm dev:web -- --host 0.0.0.0 --port 5180 --strictPort

Uses the running core API and Docker Postgres. Starts only Vite (127.0.0.1 by default).
--host exposes this authenticated preview to other devices on your network.
Auto-selects a sole Postgres container and tenant; otherwise asks for an explicit choice.
The temporary session stays in memory, renews while running, and is revoked on exit.
If the requested port is occupied, Vite selects the next free port.`);
    return;
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const webRoot = resolve(root, "web");
  const webRequire = createRequire(resolve(webRoot, "package.json"));
  const viteCLI = resolve(
    webRequire.resolve("vite/package.json"),
    "../bin/vite.js",
  );
  if (
    args.vite.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg))
  ) {
    const help = spawn(process.execPath, [viteCLI, ...args.vite], {
      cwd: webRoot,
      stdio: "inherit",
    });
    help.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  const { forwarded, config } = previewArguments(args.vite);
  const core = localURL(values.core);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("--port must be between 1024 and 65535");
  const response = await fetch(`${core}/v1/session`, {
    signal: AbortSignal.timeout(5000),
  });
  if (![200, 401].includes(response.status))
    throw new Error(`Core API unavailable (${response.status})`);
  const docker = (args, input) =>
    execFileSync("docker", args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  let container = values.postgres;
  if (!container) {
    const containers = docker([
      "ps",
      "--filter",
      "label=com.docker.compose.service=postgres",
      "--format",
      "{{.Names}}",
    ])
      .split("\n")
      .filter(Boolean);
    if (containers.length !== 1)
      throw new Error(
        `Select the running database with --postgres CONTAINER. Candidates: ${containers.join(", ") || "none"}`,
      );
    container = containers[0];
  }
  const query = (sql) =>
    docker(
      [
        "exec",
        "-i",
        container,
        "psql",
        "-X",
        "-U",
        "postgres",
        "-d",
        "monitor",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      sql,
    );
  const tenants = query("SELECT id FROM tenants ORDER BY id;")
    .split("\n")
    .filter(Boolean);
  const tenant =
    values.tenant || (tenants.length === 1 ? tenants[0] : undefined);
  if (!tenant || !tenants.includes(tenant))
    throw new Error(
      `Select a tenant with --tenant UUID. Candidates: ${tenants.join(", ") || "none"}`,
    );
  if (!/^[0-9a-f-]{36}$/i.test(tenant)) throw new Error("Invalid tenant UUID");
  const webURL = query("SELECT value FROM config WHERE key='web_app_url';");
  if (!webURL)
    throw new Error(
      "The running core must have web_app_url configured. See CONTRIBUTING.md.",
    );
  const origin = new URL(webURL).origin;
  const session = randomBytes(32).toString("base64url");
  const digest = createHash("sha256").update(session).digest("hex");
  let child,
    renewal,
    stopping = false,
    registered = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    clearInterval(renewal);
    revoke();
    child?.kill("SIGTERM");
    process.exitCode = code;
  };
  function revoke() {
    if (!registered) return;
    registered = false;
    try {
      query(`DELETE FROM web_sessions WHERE digest='${digest}';`);
    } catch {
      console.error(
        "Could not revoke the preview session; it will expire within 12 hours.",
      );
    }
  }
  // Keep synchronous cleanup as a fallback for unexpected parent exit.
  process.once("exit", revoke);
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  try {
    query(
      `INSERT INTO web_sessions(digest,tenant_id) VALUES('${digest}','${tenant}');`,
    );
    registered = true;
    const check = await fetch(`${core}/v1/session`, {
      headers: { Cookie: `__Host-midden=${session}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!check.ok || (await check.json()).tenant_id !== tenant)
      throw new Error(
        "Preview session rejected: verify --core and --postgres refer to the same stack.",
      );
    child = spawn(
      process.execPath,
      [
        viteCLI,
        "--port",
        String(port),
        ...forwarded,
        "--config",
        resolve(root, "scripts/dev-web-vite.config.mjs"),
      ],
      {
        cwd: webRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          MIDDEN_PREVIEW_SESSION: session,
          MIDDEN_PREVIEW_ORIGIN: origin,
          MIDDEN_PREVIEW_CORE: core,
          MIDDEN_PREVIEW_CONFIG: resolve(webRoot, config || "vite.config.ts"),
        },
      },
    );
    child.on("error", () => {
      console.error("Could not start Vite");
      void stop(1);
    });
    child.on("exit", (code) => {
      void stop(code ?? 1);
    });
    renewal = setInterval(
      () => {
        try {
          query(
            `UPDATE web_sessions SET expires_at=now()+interval '12 hours' WHERE digest='${digest}';`,
          );
        } catch {
          console.error(
            "Preview session renewal failed. Restart pnpm dev:web when the database is available.",
          );
        }
      },
      6 * 60 * 60 * 1000,
    );
    renewal.unref();
    console.log(
      `\nLocal preview · tenant ${tenant} · core ${core}\nUsing real data. Ctrl+C stops the frontend and revokes its temporary session.`,
    );
  } catch (error) {
    // Never print a subprocess error object: it could contain credential-bearing input.
    console.error(
      error instanceof Error && !("stderr" in error)
        ? error.message
        : "Local preview setup failed. Check the running Docker/Postgres stack.",
    );
    await stop(1);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error && !("stderr" in error)
        ? error.message
        : "Cannot access the local database. Check Docker and --postgres.",
    );
    process.exitCode = 1;
  });
}
