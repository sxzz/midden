import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function fixture(t, fail = false) {
  const root = await mkdtemp(join(tmpdir(), "midden-adapters-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "server.mjs"),
    await readFile(new URL("../adapters/server.mjs", import.meta.url)),
  );
  for (const name of ["x", "instagram"]) {
    await mkdir(join(root, name, "dist"), { recursive: true });
    await writeFile(
      join(root, name, "dist", "server.js"),
      `process.stdout.write('${name} ready\\n'); setInterval(() => {}, 1000); process.on('SIGTERM', () => { process.stdout.write('${name} stopped\\n'); process.exit(0); }); ${name === "instagram" && fail ? "setTimeout(() => process.exit(23), 50);" : ""}`,
    );
  }
  const child = spawn(process.execPath, [join(root, "server.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  return { child, output: () => output };
}

test(
  "a failed Instagram listener stops its sibling and fails the container",
  { timeout: 10000 },
  async (t) => {
    const run = await fixture(t, true);
    const [code] = await once(run.child, "exit");
    assert.equal(code, 1);
    assert.match(run.output(), /x stopped/);
  },
);

test(
  "container termination gracefully stops both listeners",
  { timeout: 10000 },
  async (t) => {
    const run = await fixture(t);
    while (
      !run.output().includes("instagram ready") ||
      !run.output().includes("x ready")
    )
      await once(run.child.stdout, "data");
    const exited = once(run.child, "exit");
    run.child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0);
    assert.match(run.output(), /x stopped/);
    assert.match(run.output(), /instagram stopped/);
  },
);
