#!/usr/bin/env node
// Install only the local connector. Account authorization, tunnel creation and DNS are separate.
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const label = "org.midden.cloudflared";
const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

function findCloudflared() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, "cloudflared");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("cloudflared is not installed or not on PATH.");
}

export function installTunnel(options, runtime = {}) {
  const {
    hostname,
    tunnelID,
    credentials,
    prepareOnly = false,
    home = homedir(),
    deployWebhookPort,
  } = options;
  const run = runtime.run ?? spawnSync;
  const platform = runtime.platform ?? process.platform;
  const uid = runtime.uid ?? process.getuid?.();
  if (!prepareOnly && platform !== "darwin")
    throw new Error(
      "LaunchAgent installation requires macOS; use --prepare-only to generate files.",
    );
  if (
    typeof hostname !== "string" ||
    hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      hostname,
    )
  )
    throw new Error(
      "Provide a DNS hostname without scheme, port, path or wildcard.",
    );
  if (
    deployWebhookPort !== undefined &&
    !(
      Number.isInteger(deployWebhookPort) &&
      deployWebhookPort > 0 &&
      deployWebhookPort < 65536
    )
  )
    throw new Error("Provide a valid deploy webhook port.");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      tunnelID ?? "",
    )
  )
    throw new Error("Provide the existing tunnel UUID.");
  const binary = options.cloudflared
    ? resolve(options.cloudflared)
    : findCloudflared();
  accessSync(binary, constants.X_OK);
  if (!isAbsolute(home))
    throw new Error("The user home directory must be absolute.");
  let secret;
  try {
    secret = JSON.parse(readFileSync(credentials, "utf8"));
  } catch {
    throw new Error("Cannot read a valid tunnel credentials JSON file.");
  }
  if (
    String(secret?.TunnelID).toLowerCase() !== tunnelID.toLowerCase() ||
    !secret.TunnelSecret ||
    !secret.AccountTag
  )
    throw new Error(
      "Credentials do not match this tunnel UUID or are incomplete.",
    );
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
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
  if (!prepareOnly) invoke("launchctl", ["print", domain]);
  const directory = join(home, ".cloudflared", "midden");
  const agents = join(home, "Library", "LaunchAgents");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(directory, ".install-"));
  const configPath = join(directory, "config.yml");
  const credentialsPath = join(directory, "credentials.json");
  const plistPath = join(agents, `${label}.plist`);
  // The deploy webhook exposes exactly one path; everything else reaches core.
  const webhook =
    deployWebhookPort === undefined
      ? ""
      : `  - hostname: ${JSON.stringify(hostname.toLowerCase())}\n    path: "^/hooks/deploy$"\n    service: http://127.0.0.1:${deployWebhookPort}\n`;
  const config = `tunnel: ${JSON.stringify(tunnelID)}\ncredentials-file: ${JSON.stringify(credentialsPath)}\ningress:\n${webhook}  - hostname: ${JSON.stringify(hostname.toLowerCase())}\n    service: http://127.0.0.1:18080\n  - service: http_status:404\n`;
  const args = [
    binary,
    "--no-autoupdate",
    "tunnel",
    "--config",
    configPath,
    "run",
    tunnelID,
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>WorkingDirectory</key><string>${xml(directory)}</string>
<key>StandardOutPath</key><string>${xml(join(directory, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(directory, "stderr.log"))}</string>
</dict></plist>\n`;
  try {
    writeFileSync(join(staging, "config.yml"), config, { mode: 0o600 });
    writeFileSync(
      join(staging, "credentials.json"),
      JSON.stringify(secret) + "\n",
      { mode: 0o600 },
    );
    writeFileSync(join(staging, "agent.plist"), plist, { mode: 0o600 });
    invoke(binary, [
      "tunnel",
      "--config",
      join(staging, "config.yml"),
      "ingress",
      "validate",
    ]);
    if (platform === "darwin")
      invoke("plutil", ["-lint", join(staging, "agent.plist")]);
    if (
      !prepareOnly &&
      run("launchctl", ["print", target], { stdio: "ignore" }).status === 0
    )
      invoke("launchctl", ["bootout", target]);
    renameSync(join(staging, "credentials.json"), credentialsPath);
    renameSync(join(staging, "config.yml"), configPath);
    renameSync(join(staging, "agent.plist"), plistPath);
    if (!prepareOnly) {
      invoke("launchctl", ["enable", target]);
      invoke("launchctl", ["bootstrap", domain, plistPath]);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return {
    configPath,
    plistPath,
    target,
    url: `https://${hostname.toLowerCase()}/app/`,
    prepareOnly,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [hostname, tunnelID, credentials, ...flags] = process.argv.slice(2);
    const options = { hostname, tunnelID, credentials };
    for (let index = 0; index < flags.length; index++) {
      if (flags[index] === "--prepare-only") options.prepareOnly = true;
      else if (flags[index] === "--cloudflared" && flags[index + 1])
        options.cloudflared = flags[++index];
      else if (flags[index] === "--deploy-webhook-port" && flags[index + 1])
        options.deployWebhookPort = Number(flags[++index]);
      else
        throw new Error(
          "Usage: node scripts/install-cloudflare-tunnel.mjs <hostname> <tunnel-uuid> <credentials.json> [--prepare-only] [--cloudflared /path/to/cloudflared] [--deploy-webhook-port PORT]",
        );
    }
    const result = installTunnel(options);
    console.log(
      `${result.prepareOnly ? "Prepared" : "Installed"} ${result.target}\nConfig: ${result.configPath}\nLaunchAgent: ${result.plistPath}\nExpected URL after DNS and tunnel connection are ready: ${result.url}`,
    );
    if (!result.prepareOnly)
      console.log(
        "LaunchAgent registration completed; verify connector logs and the public URL separately.",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
