#!/usr/bin/env node
// Deploy on GitHub "images" workflow webhooks. The payload is only a trigger:
// deploy-latest.sh resolves the release from GHCR and origin/main itself.
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PATH = "/hooks/deploy";
const MAX_BODY = 1 << 20;

export function verifySignature(secret, body, header) {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
  );
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Only a successful image build of a push to main can be a new release.
export function isRelease(event, payload, repository) {
  const run = payload?.workflow_run;
  return (
    event === "workflow_run" &&
    payload.action === "completed" &&
    payload.repository?.full_name === repository &&
    run?.name === "images" &&
    run.conclusion === "success" &&
    run.event === "push" &&
    run.head_branch === "main"
  );
}

// Runs one deployment at a time; triggers during a run collapse into one rerun.
export function createDeployer(deploy) {
  let running = null;
  let pending = false;
  const loop = async () => {
    do {
      pending = false;
      await deploy();
    } while (pending);
    running = null;
  };
  return () => {
    if (running) {
      pending = true;
      return running;
    }
    running = loop();
    return running;
  };
}

export function createHandler({ secret, repository, trigger }) {
  return (req, res) => {
    const reply = (status, text = "") => {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end(text);
    };
    if (req.url !== PATH) return reply(404);
    if (req.method !== "POST") return reply(405);
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reply(413);
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const body = Buffer.concat(chunks);
      if (!verifySignature(secret, body, req.headers["x-hub-signature-256"]))
        return reply(401);
      const event = req.headers["x-github-event"];
      if (event === "ping") return reply(200, "pong");
      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        return reply(400);
      }
      if (!isRelease(event, payload, repository)) return reply(204);
      trigger();
      reply(202, "deployment scheduled");
    });
  };
}

function run(command, args, options) {
  return new Promise((done) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output += chunk;
        options.log?.write(chunk);
      });
    child.on("error", (error) =>
      done({ code: 1, output: output + error.message }),
    );
    child.on("close", (code) => done({ code, output }));
  });
}

function readEnv(file) {
  const values = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const index = line.indexOf("=");
      if (index > 0 && !line.startsWith("#"))
        values[line.slice(0, index)] = line.slice(index + 1);
    }
  } catch {}
  return values;
}

// Message only the configured operator; the token stays inside the database.
async function notify(dir, text) {
  const chat = readEnv(join(dir, ".env")).DEPLOY_NOTIFY_CHAT_ID;
  if (!chat) return;
  const { code, output } = await run(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "monitor",
      "-At",
      "-c",
      "SELECT value FROM config WHERE key='telegram_bot_token'",
    ],
    { cwd: dir },
  );
  const token = output.trim();
  if (code !== 0 || !/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) {
    console.error("Deployment notification skipped: bot token unavailable.");
    return;
  }
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000) }),
      },
    );
    if (!response.ok)
      console.error(`Deployment notification failed: HTTP ${response.status}`);
  } catch (error) {
    console.error(`Deployment notification failed: ${error.message}`);
  }
}

function deployedRevision(dir) {
  const image =
    readEnv(join(dir, ".local", "deployed-images.env")).CORE_IMAGE ?? "";
  return /:sha-([a-f0-9]{40})$/.exec(image)?.[1] ?? "";
}

export async function deployLatest(dir) {
  const logs = join(dir, ".local", "deploy-webhook");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const log = createWriteStream(
    join(logs, `${new Date().toISOString().replaceAll(":", "")}.log`),
    { mode: 0o600 },
  );
  // Use the deployment entry point from main, outside the checkout it switches.
  const script = join(
    tmpdir(),
    `midden-deploy-${process.pid}-${Date.now()}.sh`,
  );
  try {
    let result = await run("git", ["fetch", "origin", "main"], {
      cwd: dir,
      log,
    });
    if (result.code !== 0) throw new Error("git fetch failed");
    result = await run(
      "git",
      ["show", "origin/main:scripts/deploy-latest.sh"],
      { cwd: dir },
    );
    if (result.code !== 0) throw new Error("deploy-latest.sh missing on main");
    writeFileSync(script, result.output, { mode: 0o700 });
    const env = { ...process.env, MIDDEN_DIR: dir };
    result = await run("bash", [script, "--check"], { cwd: dir, env, log });
    const revision = /Ready to deploy ([a-f0-9]{40})/.exec(result.output)?.[1];
    if (result.code !== 0 || !revision)
      throw new Error(
        `release check failed\n${result.output.trim().split("\n").slice(-5).join("\n")}`,
      );
    if (revision === deployedRevision(dir)) {
      log.write(`Already deployed ${revision}\n`);
      return;
    }
    result = await run("bash", [script], { cwd: dir, env, log });
    const tail = result.output.trim().split("\n").slice(-6).join("\n");
    if (result.code === 0)
      await notify(
        dir,
        `✅ midden 部署成功\n版本 ${revision.slice(0, 7)}\n${tail}`,
      );
    else
      await notify(
        dir,
        `❌ midden 部署失败（版本 ${revision.slice(0, 7)}）\n${tail}`,
      );
  } catch (error) {
    log.write(`${error.message}\n`);
    await notify(dir, `❌ midden 部署未开始\n${error.message}`);
  } finally {
    rmSync(script, { force: true });
    log.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dir = resolve(
    process.env.MIDDEN_DIR ?? join(process.env.HOME, "midden"),
  );
  const secret = readFileSync(
    process.env.DEPLOY_WEBHOOK_SECRET_FILE ??
      join(dir, ".local", "deploy-webhook.secret"),
    "utf8",
  ).trim();
  if (secret.length < 32)
    throw new Error("Deploy webhook secret must have at least 32 characters.");
  const port = Number(process.env.DEPLOY_WEBHOOK_PORT ?? 18090);
  const repository = process.env.DEPLOY_WEBHOOK_REPOSITORY ?? "sxzz/midden";
  const trigger = createDeployer(() => deployLatest(dir));
  createServer(createHandler({ secret, repository, trigger })).listen(
    port,
    "127.0.0.1",
    () => console.log(`Deploy webhook listening on 127.0.0.1:${port}${PATH}`),
  );
}
