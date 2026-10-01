#!/usr/bin/env node
// Install the deploy webhook receiver as a LaunchAgent. GitHub webhook setup
// and the tunnel route (install-cloudflare-tunnel.mjs --deploy-webhook-port) are separate.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const label = "org.midden.deploy-webhook";
const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

function findBinary(name, path) {
  for (const directory of (path ?? "").split(delimiter)) {
    const candidate = resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`${name} is not installed or not on PATH.`);
}

export function installWebhook(options, runtime = {}) {
  const { dir, port = 18090, prepareOnly = false, home = homedir() } = options;
  const run = runtime.run ?? spawnSync;
  const platform = runtime.platform ?? process.platform;
  const uid = runtime.uid ?? process.getuid?.();
  const path = runtime.path ?? process.env.PATH;
  if (!prepareOnly && platform !== "darwin")
    throw new Error(
      "LaunchAgent installation requires macOS; use --prepare-only to generate files.",
    );
  if (!isAbsolute(dir ?? "") || !existsSync(join(dir, "compose.yaml")))
    throw new Error("Provide the absolute path of the deployment checkout.");
  if (!Number.isInteger(port) || port <= 0 || port >= 65536)
    throw new Error("Provide a valid port.");
  // The agent's PATH must reach the tools deployments call.
  const node = runtime.node ?? process.execPath;
  const tools = [
    dirname(node),
    ...["docker", "git", "curl"].map((name) => dirname(findBinary(name, path))),
  ];
  const invoke = (command, args) => {
    const result = run(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `${command} ${args[0]} failed; check local configuration and the logged-in user session.`,
      );
    return result;
  };
  const local = join(dir, ".local");
  const logs = join(local, "deploy-webhook");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const secretPath = join(local, "deploy-webhook.secret");
  const created = !existsSync(secretPath);
  if (created)
    writeFileSync(secretPath, randomBytes(32).toString("hex") + "\n", {
      mode: 0o600,
    });
  chmodSync(secretPath, 0o600);
  if (readFileSync(secretPath, "utf8").trim().length < 32)
    throw new Error("The existing webhook secret is too short.");
  // Run a copy outside the checkout, which deployments switch between revisions.
  const installDir = join(home, ".local", "share", "midden");
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  const script = join(installDir, "deploy-webhook.mjs");
  copyFileSync(
    fileURLToPath(new URL("./deploy-webhook.mjs", import.meta.url)),
    script,
  );
  chmodSync(script, 0o600);
  const agents = join(home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  const plistPath = join(agents, `${label}.plist`);
  const env = {
    MIDDEN_DIR: dir,
    DEPLOY_WEBHOOK_PORT: String(port),
    PATH: [
      ...new Set([...tools, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
    ].join(":"),
  };
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("")}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>WorkingDirectory</key><string>${xml(dir)}</string>
<key>StandardOutPath</key><string>${xml(join(logs, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "stderr.log"))}</string>
</dict></plist>\n`;
  writeFileSync(plistPath, plist, { mode: 0o600 });
  if (platform === "darwin") invoke("plutil", ["-lint", plistPath]);
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  if (!prepareOnly) {
    if (run("launchctl", ["print", target], { stdio: "ignore" }).status === 0)
      invoke("launchctl", ["bootout", target]);
    invoke("launchctl", ["enable", target]);
    invoke("launchctl", ["bootstrap", domain, plistPath]);
  }
  return { plistPath, script, secretPath, created, target, prepareOnly };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [dir, ...flags] = process.argv.slice(2);
    const options = { dir: dir && resolve(dir) };
    for (let index = 0; index < flags.length; index++) {
      if (flags[index] === "--prepare-only") options.prepareOnly = true;
      else if (flags[index] === "--port" && flags[index + 1])
        options.port = Number(flags[++index]);
      else
        throw new Error(
          "Usage: node scripts/install-deploy-webhook.mjs <midden-dir> [--port 18090] [--prepare-only]",
        );
    }
    const result = installWebhook(options);
    console.log(
      `${result.prepareOnly ? "Prepared" : "Installed"} ${result.target}\nLaunchAgent: ${result.plistPath}\nWebhook secret: ${result.secretPath}${result.created ? " (new)" : ""}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
