// Bootstrap the native pnpm binary in Docker without npm or Corepack.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const releases = {
  "12.6.0": {
    arm64: "973af2b3eb9509416cf889a7336705062c936407d5fda07298814e7532f5dea1",
    x64: "3f4c66f668d0e84219679982d095b30da68325e1fac9284e7f5dc1584bd3d13e",
  },
};
const { devEngines } = JSON.parse(await readFile("package.json", "utf8"));
const version = devEngines.packageManager.version;
const expected = releases[version]?.[process.arch];
if (process.platform !== "linux" || !expected) {
  throw new Error(
    `Unsupported pnpm release/platform: ${version}/${process.platform}/${process.arch}`,
  );
}
const response = await fetch(
  `https://github.com/pnpm/pnpm/releases/download/v${version}/pnpm-linux-${process.arch}.tar.gz`,
  { signal: AbortSignal.timeout(120_000) },
);
if (!response.ok)
  throw new Error(`pnpm download failed: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(archive).digest("hex") !== expected) {
  throw new Error("pnpm download checksum mismatch");
}
const directory = await mkdtemp(join(tmpdir(), "pnpm-"));
try {
  const path = join(directory, "pnpm.tar.gz");
  await writeFile(path, archive);
  execFileSync("tar", ["-xzf", path, "-C", "/usr/local/bin"]);
} finally {
  await rm(directory, { recursive: true, force: true });
}
