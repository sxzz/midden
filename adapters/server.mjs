import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// One failed listener makes the container unhealthy; let Compose restart both.
const children = [
  ["./x/dist/server.js", process.env.ADAPTER_LISTEN ?? "0.0.0.0:9091"],
  [
    "./instagram/dist/server.js",
    process.env.INSTAGRAM_ADAPTER_LISTEN ?? "0.0.0.0:9092",
  ],
].map(([path, address]) =>
  spawn(process.execPath, [fileURLToPath(new URL(path, import.meta.url))], {
    stdio: "inherit",
    env: { ...process.env, ADAPTER_LISTEN: address },
  }),
);
let stopping = false;
let remaining = children.length;
let timer;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  timer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5000);
  timer.unref();
}
for (const child of children) {
  child.on("error", () => stop(1));
  child.on("exit", () => {
    stop(1);
    if (--remaining === 0) clearTimeout(timer);
  });
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop(0));
