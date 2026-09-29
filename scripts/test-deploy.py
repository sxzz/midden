#!/usr/bin/env python3
"""Exercise deployment orchestration without Docker, network access, or real credentials."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
DOCKER = r"""#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['MOCK_LOG'], 'a') as f:
    f.write(json.dumps(args) + '\n')
s = ' '.join(args)
if 'psql' in args:
    print(os.environ.get('MOCK_CHANNEL', 'channel-id') if "SELECT value" in s else 't')
elif 'ps' in args and '--services' in args:
    print('core\nadapter')
    if os.environ.get('MOCK_TELEGRAM') == 'running' or ('--all' in args and os.environ.get('MOCK_TELEGRAM') == 'stopped'):
        print('telegram')
elif 'ps' in args and '-q' in args:
    print('telegram-container')
elif 'pg_dump' in args:
    print('database backup')
elif 'migrate' in args and os.environ.get('MOCK_MIGRATE_FAIL') == '1':
    sys.exit(1)
elif 'port' in args:
    print('127.0.0.1:' + args[-1])
elif args[0] == 'inspect':
    print('0' if args[-2] == '{{.RestartCount}}' else os.environ.get('MOCK_CONTAINER_STATE', 'true false 0'))
"""


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / ".local").mkdir()
        (self.root / ".env").write_text("EXISTING=value\nTELEGRAM_CHANNEL_ID=old\n")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, content in {
            "docker": DOCKER,
            "sleep": "#!/bin/sh\nexit 0\n",
            "curl": '#!/bin/sh\nexit "${MOCK_HEALTH_FAIL:-0}"\n',
        }.items():
            path = bin_dir / name
            path.write_text(content)
            path.chmod(0o755)
        self.env = dict(
            os.environ,
            PATH=f"{bin_dir}:{os.environ['PATH']}",
            MOCK_LOG=str(self.root / "calls"),
            CORE_IMAGE="core:sha-test",
            ADAPTER_IMAGE="adapter:sha-test",
        )

    def deploy(self, **overrides):
        self.env.update(overrides)
        return subprocess.run(
            [
                "bash",
                "-ec",
                'set -uo pipefail; umask 077; source "$1"; deploy_revision abcdef123 "$2"',
                "test",
                str(SCRIPTS / "deploy-common.sh"),
                f"backup-{len(list(self.root.glob('backup-*')))}",
            ],
            cwd=self.root,
            env=self.env,
            text=True,
            capture_output=True,
        )

    def calls(self):
        return [
            json.loads(line) for line in (self.root / "calls").read_text().splitlines()
        ]

    def starts_telegram(self):
        return any("up" in c and c[-1] == "telegram" for c in self.calls())

    def test_embedded_bot_is_migrated_and_enabled(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.starts_telegram())
        calls = self.calls()
        stop = next(i for i, c in enumerate(calls) if "stop" in c and c[-1] == "core")
        backup = next(i for i, c in enumerate(calls) if "pg_dump" in c)
        migrate = next(i for i, c in enumerate(calls) if c[-1] == "migrate")
        self.assertLess(stop, backup)
        self.assertLess(backup, migrate)
        self.assertIn(
            "TELEGRAM_CHANNEL_ID=channel-id", (self.root / ".env").read_text()
        )
        self.assertEqual((self.root / ".env").stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.root / ".local/deploy-telegram-state").exists())

    def test_stopped_standalone_stays_stopped(self):
        result = self.deploy(MOCK_TELEGRAM="stopped")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.starts_telegram())

    def test_running_standalone_is_restarted(self):
        result = self.deploy(MOCK_TELEGRAM="running")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.starts_telegram())

    def test_missing_channel_fails_before_stopping(self):
        self.assertNotEqual(self.deploy(MOCK_CHANNEL="").returncode, 0)
        self.assertFalse(any("stop" in c for c in self.calls()))

    def test_failed_migration_preserves_backup_and_retry_intent(self):
        self.assertNotEqual(self.deploy(MOCK_MIGRATE_FAIL="1").returncode, 0)
        self.assertFalse(self.starts_telegram())
        self.assertTrue((self.root / "backup-0/database.dump").exists())
        self.assertEqual(
            (self.root / ".local/deploy-telegram-state").read_text(), "true\n"
        )
        result = self.deploy(MOCK_MIGRATE_FAIL="0", MOCK_TELEGRAM="stopped")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.starts_telegram())

    def test_failed_health_does_not_start_telegram(self):
        self.assertNotEqual(self.deploy(MOCK_HEALTH_FAIL="1").returncode, 0)
        self.assertFalse(self.starts_telegram())

    def test_telegram_restart_backoff_is_not_healthy(self):
        self.assertNotEqual(
            self.deploy(MOCK_CONTAINER_STATE="true true 0").returncode, 0
        )
        self.assertEqual(self.calls()[-1][-2:], ["stop", "telegram"])

    def test_telegram_crash_loop_fails_and_stops_poller(self):
        self.assertNotEqual(
            self.deploy(MOCK_CONTAINER_STATE="true false 1").returncode, 0
        )
        self.assertEqual(self.calls()[-1][-2:], ["stop", "telegram"])


if __name__ == "__main__":
    unittest.main()
