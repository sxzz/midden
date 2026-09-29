import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
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

test("local storage configuration generates private credentials and preserves them on rerun", (t) => {
  const root = mkdtempSync(join(tmpdir(), "midden-local-storage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  copyFileSync(
    new URL("configure-local-storage.mjs", import.meta.url),
    join(root, "scripts/configure-local-storage.mjs"),
  );
  writeFileSync(
    join(root, ".env.example"),
    "# Preserved comment\nPOSTGRES_PASSWORD=replace-this\nAPP_DB_PASSWORD=\nADAPTER_TOKEN=existing-token\nCUSTOM=value=with-equals\n",
  );
  const run = () =>
    spawnSync(process.execPath, ["scripts/configure-local-storage.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const env = readFileSync(join(root, ".env"), "utf8");
  assert.match(env, /# Preserved comment/);
  assert.match(env, /POSTGRES_PASSWORD=[a-f0-9]{64}\n/);
  assert.match(env, /APP_DB_PASSWORD=[a-f0-9]{64}\n/);
  assert.match(env, /ADAPTER_TOKEN=existing-token\n/);
  assert.match(env, /CUSTOM=value=with-equals\n/);
  assert.match(env, /COMPOSE_FILE=compose.yaml:compose.local.yaml\n/);
  assert.match(env, /S3_ENDPOINT=http:\/\/s3:8333\n/);
  const configPath = join(root, ".local/s3.json");
  const credentials = JSON.parse(readFileSync(configPath, "utf8")).identities[0]
    .credentials[0];
  assert.ok(env.includes(`S3_ACCESS_KEY=${credentials.accessKey}\n`));
  assert.ok(env.includes(`S3_SECRET_KEY=${credentials.secretKey}\n`));
  assert.ok(!result.stdout.includes(credentials.secretKey));
  assert.equal(statSync(join(root, ".env")).mode & 0o777, 0o600);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, ".local")).mode & 0o777, 0o700);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(root, ".env"), "utf8"), env);
});
