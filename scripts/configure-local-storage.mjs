#!/usr/bin/env node
// Configure private local S3 credentials without printing them.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const env = new URL(".env", root);
const lines = readFileSync(
  existsSync(env) ? env : new URL(".env.example", root),
  "utf8",
)
  .trimEnd()
  .split(/\r?\n/);
const isAssignment = (line) =>
  line && !line.startsWith("#") && line.includes("=");
const values = new Map(
  lines.filter(isAssignment).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);
values.set("COMPOSE_FILE", "compose.yaml:compose.local.yaml");
values.set("S3_ENDPOINT", "http://s3:8333");
values.set("S3_BUCKET", "monitor");
for (const key of [
  "POSTGRES_PASSWORD",
  "APP_DB_PASSWORD",
  "ADAPTER_TOKEN",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
]) {
  if (!values.get(key) || values.get(key).startsWith("replace"))
    values.set(key, randomBytes(32).toString("hex"));
}
const local = new URL(".local/", root);
mkdirSync(local, { mode: 0o700, recursive: true });
const config = {
  identities: [
    {
      name: "monitor",
      credentials: [
        {
          accessKey: values.get("S3_ACCESS_KEY"),
          secretKey: values.get("S3_SECRET_KEY"),
        },
      ],
      actions: ["Admin", "Read", "Write", "List", "Tagging"],
    },
  ],
};
function writePrivate(path, content) {
  const fd = openSync(fileURLToPath(path), "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
writePrivate(new URL("s3.json", local), JSON.stringify(config) + "\n");
const seen = new Set();
const output = lines.map((line) => {
  if (!isAssignment(line)) return line;
  const key = line.slice(0, line.indexOf("="));
  seen.add(key);
  return `${key}=${values.get(key)}`;
});
for (const [key, value] of values) {
  if (!seen.has(key)) output.push(`${key}=${value}`);
}
writePrivate(env, output.join("\n") + "\n");
console.log(
  "Local S3 configured. Credentials are in Git-ignored .env and .local/s3.json.",
);
