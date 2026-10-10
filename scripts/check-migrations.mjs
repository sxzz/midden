#!/usr/bin/env node
// Compare this branch's migrations with a base ref before merging.
// Usage: node scripts/check-migrations.mjs <base-ref>
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIRECTORY = "internal/store/migrations";

// A database applies whichever migration it has not seen, in any order, so
// this only keeps the order the same for everyone where a rebase can: files
// the base already has stay, and new ones are named to run after them.
export function problems(base, head) {
  const found = [];
  const present = new Set(head);
  for (const name of base) {
    if (!present.has(name))
      found.push(
        `${name} was removed or renamed; an applied migration stays as it is`,
      );
  }
  const last = [...base].sort().at(-1);
  const known = new Set(base);
  for (const name of [...head].sort()) {
    if (!known.has(name) && last !== undefined && name < last)
      found.push(`${name} sorts before ${last}; rename it to run last`);
  }
  return found;
}

function list(ref) {
  return execFileSync("git", ["ls-tree", "--name-only", ref, `${DIRECTORY}/`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(DIRECTORY.length + 1));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  if (!base) {
    console.error("Usage: node scripts/check-migrations.mjs <base-ref>");
    process.exit(2);
  }
  const found = problems(list(base), list("HEAD"));
  for (const problem of found) console.error(problem);
  process.exit(found.length ? 1 : 0);
}
