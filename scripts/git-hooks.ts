// Point git at the committed hooks in .githooks. Outside a git checkout, such
// as a source archive, there is nothing to set.
import { execFileSync } from 'node:child_process'

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    stdio: 'ignore',
  })
} catch {}
