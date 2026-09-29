#!/usr/bin/env python3
"""Format repository sources, or check exactly the blobs about to be committed."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / ".tools" / "format"
PRETTIER_EXTENSIONS = {
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
}
GO_TOOLS = {
    "goimports": "golang.org/x/tools/cmd/goimports@v0.36.0",
    "gofumpt": "mvdan.cc/gofumpt@v0.8.0",
    "shfmt": "mvdan.cc/sh/v3/cmd/shfmt@v3.12.0",
}
PG_FORMAT_COMMIT = "12b7750c9aff700c8df75d7643ba055e9a7d9311"


def run(command, *, data=None, env=None):
    result = subprocess.run(
        command, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env
    )
    if result.returncode:
        raise RuntimeError(
            f"{' '.join(map(str, command))}:\n{result.stderr.decode(errors='replace')}"
        )
    return result.stdout


def kind(path):
    # pnpm owns its lockfile's formatting; generated source remains checked.
    if path.name == "pnpm-lock.yaml":
        return None
    # Existing migration checksums are immutable until the baseline is replaced.
    if path.parent.as_posix() == "internal/store/migrations":
        return None
    suffix = path.suffix.lower()
    if suffix in PRETTIER_EXTENSIONS:
        return "prettier"
    if suffix == ".go":
        return "go"
    if suffix == ".py":
        return "python"
    if suffix == ".sql":
        return "sql"
    if suffix == ".sh" or path.parts[0] == ".githooks":
        return "shell"
    return None


def go_tool(name):
    module = GO_TOOLS[name]
    directory = TOOLS / f"{name}-{module.rsplit('@', 1)[1]}"
    binary = directory / name
    if not binary.exists():
        directory.mkdir(parents=True, exist_ok=True)
        print(f"Installing {module}", flush=True)
        run(["go", "install", module], env={**os.environ, "GOBIN": str(directory)})
    return str(binary)


def pg_formatter():
    installed = shutil.which("pg_format")
    if installed and run([installed, "--version"]).strip() == b"pg_format version 5.11":
        return installed
    directory = TOOLS / "pgFormatter-5.11"
    if not directory.exists():
        directory.parent.mkdir(parents=True, exist_ok=True)
        print("Installing pgFormatter 5.11", flush=True)
        run(
            [
                "git",
                "clone",
                "--depth=1",
                "--branch=v5.11",
                "https://github.com/darold/pgFormatter.git",
                str(directory),
            ]
        )
    if (
        run(["git", "-C", str(directory), "rev-parse", "HEAD"]).strip().decode()
        != PG_FORMAT_COMMIT
    ):
        raise RuntimeError("Unexpected pgFormatter 5.11 revision")
    return str(directory / "pg_format")


def commands(kinds):
    result = {}
    if "prettier" in kinds:
        prettier = ROOT / "node_modules" / ".bin" / "prettier"
        if not prettier.exists():
            raise RuntimeError("Install JavaScript dependencies first: pnpm install")
        result["prettier"] = [[str(prettier), "--stdin-filepath"]]
    if "go" in kinds:
        result["go"] = [
            [go_tool("goimports"), "-local", "monitor"],
            [go_tool("gofumpt"), "-modpath", "monitor"],
        ]
    if "shell" in kinds:
        result["shell"] = [[go_tool("shfmt")]]
    if "python" in kinds:
        result["python"] = [["uvx", "ruff@0.12.12", "format", "--stdin-filename"]]
    if "sql" in kinds:
        result["sql"] = [[pg_formatter(), "--no-extra-line"]]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="format working-tree files")
    mode.add_argument("--check", action="store_true", help="check working-tree files")
    mode.add_argument(
        "--staged",
        action="store_true",
        help="check staged blobs without modifying files",
    )
    parser.add_argument("paths", nargs="*", help="optional repository-relative paths")
    args = parser.parse_args()
    os.chdir(ROOT)
    if args.staged:
        listing = run(
            ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
        )
    else:
        listing = run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"]
        )
    names = sorted(set(os.fsdecode(name) for name in listing.split(b"\0") if name))
    if args.paths:
        names = [
            name
            for name in names
            if any(
                name == path or name.startswith(path.rstrip("/") + "/")
                for path in args.paths
            )
        ]
    files = [(Path(name), kind(Path(name))) for name in names]
    files = [
        (path, style)
        for path, style in files
        if style and (args.staged or path.is_file())
    ]
    pipelines = commands({style for _, style in files})

    def format_file(item):
        path, style = item
        if args.staged:
            # Read the index, never the working tree: partial staging stays intact.
            entry = run(["git", "ls-files", "--stage", "--", str(path)])
            if entry.startswith(b"120000 "):
                return None
            original = run(["git", "show", f":{path.as_posix()}"])
        else:
            if path.is_symlink():
                return None
            original = path.read_bytes()
        formatted = original
        # gofumpt can merge adjacent declarations before it can insert the final
        # separating blank line on a later pass. Check for convergence so a
        # successful --write always produces content accepted by --staged.
        for _ in range(4 if style == "go" else 1):
            previous = formatted
            for command in pipelines[style]:
                if style == "prettier":
                    command = [*command, str(path)]
                elif style == "python":
                    command = [*command, str(path), "-"]
                formatted = run(command, data=formatted)
            if formatted == previous:
                break
        else:
            if style == "go":
                raise RuntimeError(f"Go formatting did not converge: {path}")
        if formatted == original:
            return None
        if args.write:
            path.write_bytes(formatted)
        return str(path)

    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 1)) as pool:
        changed = [path for path in pool.map(format_file, files) if path]
    for path in changed:
        print(f"{'Formatted' if args.write else 'Needs formatting'}: {path}")
    if changed and not args.write:
        print(
            "Run `pnpm format` (or `make fmt`), review changes, then stage the intended changes.",
            file=sys.stderr,
        )
        return 1
    print(f"Formatting {'complete' if args.write else 'passed'} ({len(files)} files).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError) as error:
        print(f"Formatting failed: {error}", file=sys.stderr)
        sys.exit(1)
