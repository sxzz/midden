import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Package installs in Docker/release archives have no Git metadata.
if (existsSync(new URL("../.git", import.meta.url))) {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
  });
}
