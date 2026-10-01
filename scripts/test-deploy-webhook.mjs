import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createDeployer,
  createHandler,
  isRelease,
  PATH,
  verifySignature,
} from "./deploy-webhook.mjs";
import { installWebhook } from "./install-deploy-webhook.mjs";

const secret = "s".repeat(64);
const sign = (body) =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
const release = {
  action: "completed",
  repository: { full_name: "sxzz/midden" },
  workflow_run: {
    name: "images",
    conclusion: "success",
    event: "push",
    head_branch: "main",
  },
};

test("accepts only signatures made with the shared secret", () => {
  const body = Buffer.from("{}");
  assert.ok(verifySignature(secret, body, sign(body)));
  assert.ok(!verifySignature(secret, body, sign(Buffer.from("{ }"))));
  assert.ok(!verifySignature(secret, body, undefined));
  assert.ok(!verifySignature("other".repeat(10), body, sign(body)));
});

test("deploys only successful image builds of pushes to main", () => {
  assert.ok(isRelease("workflow_run", release, "sxzz/midden"));
  for (const change of [
    { action: "requested" },
    { repository: { full_name: "fork/midden" } },
    { workflow_run: { ...release.workflow_run, name: "test" } },
    { workflow_run: { ...release.workflow_run, conclusion: "failure" } },
    { workflow_run: { ...release.workflow_run, event: "pull_request" } },
    { workflow_run: { ...release.workflow_run, head_branch: "feature" } },
  ])
    assert.ok(
      !isRelease("workflow_run", { ...release, ...change }, "sxzz/midden"),
    );
  assert.ok(!isRelease("push", release, "sxzz/midden"));
});

test("collapses triggers during a deployment into one rerun", async () => {
  let runs = 0;
  let release;
  const trigger = createDeployer(async () => {
    runs++;
    if (runs === 1) await new Promise((done) => (release = done));
  });
  const first = trigger();
  trigger();
  trigger();
  release();
  await first;
  assert.equal(runs, 2);
  await trigger();
  assert.equal(runs, 3);
});

test("answers webhook requests without exposing a deployment to forged calls", async (t) => {
  let triggered = 0;
  const server = createServer(
    createHandler({
      secret,
      repository: "sxzz/midden",
      trigger: () => triggered++,
    }),
  );
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}, path = PATH, method = "POST") =>
    fetch(url + path, {
      method,
      body: method === "GET" ? undefined : body,
      headers,
    });
  const signed = (event, payload) => {
    const body = JSON.stringify(payload);
    return post(body, {
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": sign(Buffer.from(body)),
    });
  };
  assert.equal((await post("{}", {}, "/other")).status, 404);
  assert.equal((await post("", {}, PATH, "GET")).status, 405);
  assert.equal(
    (
      await post(JSON.stringify(release), {
        "X-GitHub-Event": "workflow_run",
        "X-Hub-Signature-256": "sha256=00",
      })
    ).status,
    401,
  );
  assert.equal((await signed("ping", { zen: "hi" })).status, 200);
  assert.equal(
    (await signed("workflow_run", { ...release, action: "requested" })).status,
    204,
  );
  assert.equal(triggered, 0);
  assert.equal((await signed("workflow_run", release)).status, 202);
  assert.equal(triggered, 1);
});

test("prepares a private secret and LaunchAgent without loading it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "midden-webhook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "midden & co");
  const home = join(root, "home");
  mkdirSync(dir);
  mkdirSync(home);
  writeFileSync(join(dir, "compose.yaml"), "services: {}\n");
  const calls = [];
  const runtime = {
    platform: "darwin",
    uid: 501,
    path: process.env.PATH,
    node: process.execPath,
    run(command, args) {
      calls.push([command, ...args]);
      return { status: 0 };
    },
  };
  const first = installWebhook({ dir, home, prepareOnly: true }, runtime);
  const secretText = readFileSync(first.secretPath, "utf8");
  assert.equal(statSync(first.secretPath).mode & 0o777, 0o600);
  assert.match(secretText, /^[0-9a-f]{64}\n$/);
  const plist = readFileSync(first.plistPath, "utf8");
  assert.match(plist, /midden &amp; co/);
  assert.match(plist, /<key>DEPLOY_WEBHOOK_PORT<\/key><string>18090<\/string>/);
  assert.ok(!plist.includes(secretText.trim()));
  assert.ok(calls.every((call) => call[0] !== "launchctl"));
  const second = installWebhook({ dir, home, prepareOnly: true }, runtime);
  assert.ok(!second.created);
  assert.equal(readFileSync(second.secretPath, "utf8"), secretText);
  assert.throws(
    () => installWebhook({ dir: home, home, prepareOnly: true }, runtime),
    /deployment checkout/,
  );
});
