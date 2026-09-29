#!/usr/bin/env node
// Format repository sources, or check exactly the blobs about to be committed.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = path.join(ROOT, ".tools", "format");
const PRETTIER_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".scss",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);
const GO_TOOLS = {
  goimports: "golang.org/x/tools/cmd/goimports@v0.36.0",
  gofumpt: "mvdan.cc/gofumpt@v0.8.0",
  shfmt: "mvdan.cc/sh/v3/cmd/shfmt@v3.12.0",
};
const PG_FORMAT_COMMIT = "12b7750c9aff700c8df75d7643ba055e9a7d9311";

function run(command, { data, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { env, stdio: "pipe" });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command.join(" ")}:\n${Buffer.concat(stderr)}`));
    });
    child.stdin.end(data);
  });
}

function kind(filename) {
  // pnpm owns its lockfile's formatting; generated source remains checked.
  if (path.basename(filename) === "pnpm-lock.yaml") return null;
  const suffix = path.extname(filename).toLowerCase();
  if (PRETTIER_EXTENSIONS.has(suffix)) return "prettier";
  if (suffix === ".go") return "go";
  if (suffix === ".sql") return "sql";
  if (suffix === ".sh" || filename.startsWith(".githooks/")) return "shell";
  return null;
}

async function goTool(name) {
  const module = GO_TOOLS[name];
  const directory = path.join(TOOLS, `${name}-${module.split("@").at(-1)}`);
  const binary = path.join(directory, name);
  if (!existsSync(binary)) {
    await mkdir(directory, { recursive: true });
    console.log(`Installing ${module}`);
    await run(["go", "install", module], {
      env: { ...process.env, GOBIN: directory },
    });
  }
  return binary;
}

async function pgFormatter() {
  try {
    if (
      (await run(["pg_format", "--version"])).toString().trim() ===
      "pg_format version 5.11"
    )
      return "pg_format";
  } catch {
    // A missing or incompatible system tool is replaced by the pinned release.
  }
  const directory = path.join(TOOLS, "pgFormatter-5.11");
  if (!existsSync(directory)) {
    await mkdir(path.dirname(directory), { recursive: true });
    console.log("Installing pgFormatter 5.11");
    await run([
      "git",
      "clone",
      "--depth=1",
      "--branch=v5.11",
      "https://github.com/darold/pgFormatter.git",
      directory,
    ]);
  }
  if (
    (await run(["git", "-C", directory, "rev-parse", "HEAD"]))
      .toString()
      .trim() !== PG_FORMAT_COMMIT
  ) {
    throw new Error("Unexpected pgFormatter 5.11 revision");
  }
  return path.join(directory, "pg_format");
}

async function commands(kinds) {
  const result = {};
  if (kinds.has("prettier")) {
    const prettier = path.join(ROOT, "node_modules", ".bin", "prettier");
    if (!existsSync(prettier))
      throw new Error("Install JavaScript dependencies first: pnpm install");
    result.prettier = [[prettier, "--stdin-filepath"]];
  }
  if (kinds.has("go")) {
    result.go = [
      [await goTool("goimports"), "-local", "monitor"],
      [await goTool("gofumpt"), "-modpath", "monitor"],
    ];
  }
  if (kinds.has("shell")) result.shell = [[await goTool("shfmt")]];
  if (kinds.has("sql")) result.sql = [[await pgFormatter(), "--no-extra-line"]];
  return result;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      write: { type: "boolean" },
      check: { type: "boolean" },
      staged: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/format.mjs (--write | --check | --staged) [repository-relative paths...]\n--staged checks index blobs without modifying files or the index.",
    );
    return 0;
  }
  if (
    [values.write, values.check, values.staged].filter(Boolean).length !== 1
  ) {
    throw new Error("Specify exactly one of --write, --check, or --staged");
  }
  process.chdir(ROOT);
  const listing = await run(
    values.staged
      ? ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
      : ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  );
  const names = [
    ...new Set(listing.toString().split("\0").filter(Boolean)),
  ].sort();
  const files = [];
  for (const filename of names) {
    if (
      positionals.length &&
      !positionals.some(
        (prefix) =>
          filename === prefix ||
          filename.startsWith(`${prefix.replace(/\/$/, "")}/`),
      )
    )
      continue;
    const style = kind(filename);
    if (!style) continue;
    if (!values.staged) {
      const stat = await lstat(filename).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat?.isFile()) continue;
    }
    files.push({ filename, style });
  }
  const pipelines = await commands(new Set(files.map(({ style }) => style)));
  async function formatFile({ filename, style }) {
    let original;
    if (values.staged) {
      // Read the index, never the working tree: partial staging stays intact.
      const entry = await run(["git", "ls-files", "--stage", "--", filename]);
      if (entry.toString().startsWith("120000 ")) return null;
      original = await run(["git", "show", `:${filename}`]);
    } else original = await readFile(filename);
    let formatted = original;
    let converged = false;
    // gofumpt may merge declarations before adding their final separating line.
    // Converge before writing so the resulting blob passes the next staged check.
    for (let pass = 0; pass < (style === "go" ? 4 : 1); pass++) {
      const previous = formatted;
      for (const command of pipelines[style]) {
        formatted = await run(
          style === "prettier" ? [...command, filename] : command,
          { data: formatted },
        );
      }
      if (formatted.equals(previous)) {
        converged = true;
        break;
      }
    }
    if (style === "go" && !converged)
      throw new Error(`Go formatting did not converge: ${filename}`);
    if (formatted.equals(original)) return null;
    if (values.write) await writeFile(filename, formatted);
    return filename;
  }
  const changed = [];
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(8, availableParallelism(), files.length) },
      async () => {
        while (cursor < files.length) {
          const filename = await formatFile(files[cursor++]);
          if (filename) changed.push(filename);
        }
      },
    ),
  );
  for (const filename of changed.sort())
    console.log(
      `${values.write ? "Formatted" : "Needs formatting"}: ${filename}`,
    );
  if (changed.length && !values.write) {
    console.error(
      "Run `pnpm format` (or `make fmt`), review changes, then stage the intended changes.",
    );
    return 1;
  }
  console.log(
    `Formatting ${values.write ? "complete" : "passed"} (${files.length} files).`,
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`Formatting failed: ${error.message}`);
  process.exitCode = 1;
}
