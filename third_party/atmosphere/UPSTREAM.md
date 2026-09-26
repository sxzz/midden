# Vendored Atmosphere

Source: https://github.com/FxEmbed/FxEmbed
Commit: `7fde93fa99df69f0fac78d6055239c90970a1c77`
Package: `packages/atmosphere`, MIT (see LICENSE).

Local patches: remove trailing whitespace in a source comment; declare cheerio/domhandler dependencies; require a request-bound account transport in twitter/fetch.ts; remove payload logging from provider/helper sources; bound transaction metadata requests to 10 seconds. The adapter copies the public application bearer from `src/constants.ts` at the same commit. The account transport owns credentials, deadlines and error classification. No guest fallback or account pool is used.

To update, compare this snapshot with the pinned commit, import the chosen upstream version and reapply these patches. Run adapter fixtures and cross-language integration tests before changing the recorded commit.
