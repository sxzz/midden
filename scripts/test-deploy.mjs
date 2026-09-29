#!/usr/bin/env node
// Exercise deployment orchestration without Docker, network access, or real credentials.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const common = fileURLToPath(new URL("deploy-common.sh", import.meta.url));
const docker = String.raw`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + "\n");
const text = args.join(" ");
if (args.includes("psql")) {
  console.log(text.includes("SELECT value") ? (process.env.MOCK_CHANNEL ?? "channel-id") : "t");
} else if (args.includes("ps") && args.includes("--services")) {
  console.log("core\nadapter");
  if (process.env.MOCK_TELEGRAM === "running" || (args.includes("--all") && process.env.MOCK_TELEGRAM === "stopped")) console.log("telegram");
} else if (args.includes("ps") && args.includes("-q")) {
  console.log("telegram-container");
} else if (args.includes("pg_dump")) {
  console.log("database backup");
} else if (args.includes("migrate") && process.env.MOCK_MIGRATE_FAIL === "1") {
  process.exit(1);
} else if (args.includes("port")) {
  console.log("127.0.0.1:" + args.at(-1));
} else if (args[0] === "inspect") {
  console.log(args.at(-2) === "{{.RestartCount}}" ? "0" : (process.env.MOCK_CONTAINER_STATE ?? "true false 0"));
}
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "midden-test-deploy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".local"));
  writeFileSync(
    join(root, ".env"),
    "EXISTING=value\nTELEGRAM_CHANNEL_ID=old\n",
  );
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const [name, content] of Object.entries({
    docker,
    sleep: "#!/bin/sh\nexit 0\n",
    curl: '#!/bin/sh\nexit "${MOCK_HEALTH_FAIL:-0}"\n',
  })) {
    writeFileSync(join(bin, name), content, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_LOG: join(root, "calls"),
    CORE_IMAGE: "core:sha-test",
    ADAPTER_IMAGE: "adapter:sha-test",
  };
  const calls = () =>
    readFileSync(join(root, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return {
    root,
    calls,
    startsTelegram: () =>
      calls().some((c) => c.includes("up") && c.at(-1) === "telegram"),
    deploy(overrides = {}) {
      Object.assign(env, overrides);
      return spawnSync(
        "bash",
        [
          "-ec",
          'set -uo pipefail; umask 077; source "$1"; deploy_revision abcdef123 "$2"',
          "test",
          common,
          `backup-${readdirSync(root).filter((name) => name.startsWith("backup-")).length}`,
        ],
        { cwd: root, env, encoding: "utf8" },
      );
    },
  };
}

test("embedded bot is migrated and enabled", (t) => {
  const f = fixture(t);
  const result = f.deploy();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.startsTelegram());
  const calls = f.calls();
  const stop = calls.findIndex(
    (c) => c.includes("stop") && c.at(-1) === "core",
  );
  const backup = calls.findIndex((c) => c.includes("pg_dump"));
  const migrate = calls.findIndex((c) => c.at(-1) === "migrate");
  assert.ok(stop >= 0 && stop < backup && backup < migrate);
  const config = readFileSync(join(f.root, ".env"), "utf8");
  assert.match(config, /TELEGRAM_CHANNEL_ID=channel-id/);
  assert.match(config, /EXISTING=value/);
  assert.doesNotMatch(config, /TELEGRAM_CHANNEL_ID=old/);
  assert.equal(statSync(join(f.root, ".env")).mode & 0o777, 0o600);
  assert.ok(!existsSync(join(f.root, ".local/deploy-telegram-state")));
});

test("stopped standalone stays stopped", (t) => {
  const f = fixture(t);
  const result = f.deploy({ MOCK_TELEGRAM: "stopped" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!f.startsTelegram());
});

test("running standalone is restarted", (t) => {
  const f = fixture(t);
  const result = f.deploy({ MOCK_TELEGRAM: "running" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.startsTelegram());
});

test("missing channel fails before stopping", (t) => {
  const f = fixture(t);
  assert.notEqual(f.deploy({ MOCK_CHANNEL: "" }).status, 0);
  assert.ok(!f.calls().some((c) => c.includes("stop")));
});

test("failed migration preserves backup and retry intent", (t) => {
  const f = fixture(t);
  assert.notEqual(f.deploy({ MOCK_MIGRATE_FAIL: "1" }).status, 0);
  assert.ok(!f.startsTelegram());
  assert.ok(existsSync(join(f.root, "backup-0/database.dump")));
  assert.equal(
    readFileSync(join(f.root, ".local/deploy-telegram-state"), "utf8"),
    "true\n",
  );
  const result = f.deploy({ MOCK_MIGRATE_FAIL: "0", MOCK_TELEGRAM: "stopped" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.startsTelegram());
});

test("failed health does not start Telegram", (t) => {
  const f = fixture(t);
  assert.notEqual(f.deploy({ MOCK_HEALTH_FAIL: "1" }).status, 0);
  assert.ok(!f.startsTelegram());
});

test("Telegram restart backoff is not healthy", (t) => {
  const f = fixture(t);
  assert.notEqual(f.deploy({ MOCK_CONTAINER_STATE: "true true 0" }).status, 0);
  assert.deepEqual(f.calls().at(-1).slice(-2), ["stop", "telegram"]);
});

test("Telegram crash loop fails and stops poller", (t) => {
  const f = fixture(t);
  assert.notEqual(f.deploy({ MOCK_CONTAINER_STATE: "true false 1" }).status, 0);
  assert.deepEqual(f.calls().at(-1).slice(-2), ["stop", "telegram"]);
});
