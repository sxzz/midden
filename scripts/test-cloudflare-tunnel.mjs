import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installTunnel } from "./install-cloudflare-tunnel.mjs";

const tunnelID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "midden-cloudflare-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "User & space");
  mkdirSync(home);
  const credentials = join(root, "original.json");
  writeFileSync(
    credentials,
    JSON.stringify({
      TunnelID: tunnelID,
      TunnelSecret: "do-not-log-me",
      AccountTag: "test-account",
    }),
  );
  const calls = [];
  const runtime = {
    platform: "darwin",
    uid: 501,
    run(command, args) {
      calls.push([command, ...args]);
      return { status: 0 };
    },
  };
  const options = {
    hostname: "midden.example.com",
    tunnelID,
    credentials,
    home,
    cloudflared: process.execPath,
  };
  return { root, home, options, runtime, calls };
}

test("prepares a private core-only config and escaped LaunchAgent without loading it", (t) => {
  const f = fixture(t);
  const result = installTunnel({ ...f.options, prepareOnly: true }, f.runtime);
  const config = readFileSync(result.configPath, "utf8");
  assert.match(config, /service: http:\/\/127\.0\.0\.1:18080/);
  assert.match(config, /service: http_status:404/);
  assert.doesNotMatch(config, /19090|8081|18333|do-not-log-me/);
  assert.ok(f.calls.every((call) => call[0] !== "launchctl"));
  assert.ok(f.calls.some((call) => call.includes("validate")));
  if (process.platform === "darwin") {
    const lint = spawnSync("plutil", ["-lint", result.plistPath], {
      encoding: "utf8",
    });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
  const plist = readFileSync(result.plistPath, "utf8");
  assert.match(plist, /User &amp; space/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.doesNotMatch(plist, /do-not-log-me/);
  assert.equal(statSync(result.configPath).mode & 0o777, 0o600);
  assert.equal(
    statSync(join(f.home, ".cloudflared/midden/credentials.json")).mode & 0o777,
    0o600,
  );
  assert.equal(
    statSync(join(f.home, ".cloudflared/midden")).mode & 0o777,
    0o700,
  );
});

test("reloads only its own agent and validates before stopping the existing service", (t) => {
  const f = fixture(t);
  const result = installTunnel(f.options, f.runtime);
  const validate = f.calls.findIndex((call) => call.includes("validate"));
  const stop = f.calls.findIndex((call) => call.includes("bootout"));
  const start = f.calls.findIndex((call) => call.includes("bootstrap"));
  assert.ok(validate < stop && stop < start);
  assert.deepEqual(f.calls[stop], [
    "launchctl",
    "bootout",
    "gui/501/org.midden.cloudflared",
  ]);
  assert.deepEqual(f.calls[start], [
    "launchctl",
    "bootstrap",
    "gui/501",
    result.plistPath,
  ]);
  assert.ok(
    !f.calls.some(
      (call) =>
        call.includes("sudo") ||
        call.includes("dns") ||
        call.includes("create"),
    ),
  );
});

test("invalid credentials or hostname fail before touching launchd or configuration", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      installTunnel(
        { ...f.options, hostname: "https://example.com/app/" },
        f.runtime,
      ),
    /DNS hostname/,
  );
  assert.throws(
    () =>
      installTunnel(
        { ...f.options, tunnelID: "00000000-bbbb-cccc-dddd-eeeeeeeeeeee" },
        f.runtime,
      ),
    /Credentials do not match/,
  );
  assert.equal(f.calls.length, 0);
  assert.ok(!existsSync(join(f.home, ".cloudflared")));
});

test("failed validation preserves the current configuration and running service", (t) => {
  const f = fixture(t);
  const result = installTunnel({ ...f.options, prepareOnly: true }, f.runtime);
  const original = readFileSync(result.configPath, "utf8");
  f.calls.length = 0;
  const run = f.runtime.run;
  f.runtime.run = (command, args) =>
    args.includes("validate") ? { status: 1 } : run(command, args);
  assert.throws(
    () =>
      installTunnel({ ...f.options, hostname: "other.example.com" }, f.runtime),
    /failed/,
  );
  assert.equal(readFileSync(result.configPath, "utf8"), original);
  assert.ok(!f.calls.some((call) => call.includes("bootout")));
});

test("missing GUI login session fails without installing partial files", (t) => {
  const f = fixture(t);
  f.runtime.run = () => ({ status: 1 });
  assert.throws(
    () => installTunnel(f.options, f.runtime),
    /logged-in user session/,
  );
  assert.ok(!existsSync(join(f.home, ".cloudflared")));
});

test("routes only the deploy webhook path to the webhook port", (t) => {
  const f = fixture(t);
  const result = installTunnel(
    { ...f.options, prepareOnly: true, deployWebhookPort: 18090 },
    f.runtime,
  );
  const config = readFileSync(result.configPath, "utf8");
  const webhook = config.indexOf('path: "^/hooks/deploy$"');
  assert.ok(webhook > 0 && webhook < config.indexOf("127.0.0.1:18080"));
  assert.match(config, /service: http:\/\/127\.0\.0\.1:18090/);
  assert.throws(
    () =>
      installTunnel(
        { ...f.options, prepareOnly: true, deployWebhookPort: 70000 },
        f.runtime,
      ),
    /deploy webhook port/,
  );
});
