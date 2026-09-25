#!/usr/bin/env python3
"""Configure private local S3 credentials without printing them."""

import json
import os
from pathlib import Path
import secrets

root = Path(__file__).resolve().parent.parent
env = root / ".env"
lines = (env if env.exists() else root / ".env.example").read_text().splitlines()
values = dict(
    line.split("=", 1)
    for line in lines
    if line and not line.startswith("#") and "=" in line
)
values.update(
    COMPOSE_FILE="compose.yaml:compose.local.yaml",
    S3_ENDPOINT="http://s3:8333",
    S3_BUCKET="monitor",
)
for key in [
    "POSTGRES_PASSWORD",
    "APP_DB_PASSWORD",
    "ADAPTER_TOKEN",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
]:
    if not values.get(key) or values[key].startswith("replace"):
        values[key] = secrets.token_hex(32)
local = root / ".local"
local.mkdir(mode=0o700, exist_ok=True)
config = {
    "identities": [
        {
            "name": "monitor",
            "credentials": [
                {
                    "accessKey": values["S3_ACCESS_KEY"],
                    "secretKey": values["S3_SECRET_KEY"],
                }
            ],
            "actions": ["Admin", "Read", "Write", "List", "Tagging"],
        }
    ]
}
fd = os.open(local / "s3.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as out:
    json.dump(config, out)
output, seen = [], set()
for line in lines:
    if line and not line.startswith("#") and "=" in line:
        key = line.split("=", 1)[0]
        line = key + "=" + values[key]
        seen.add(key)
    output.append(line)
output.extend(key + "=" + value for key, value in values.items() if key not in seen)
fd = os.open(env, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as out:
    out.write("\n".join(output) + "\n")
env.chmod(0o600)
(local / "s3.json").chmod(0o600)
print("Local S3 configured. Credentials are in Git-ignored .env and .local/s3.json.")
