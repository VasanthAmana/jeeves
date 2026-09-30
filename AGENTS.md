# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test` (Node's built-in runner over `test/**/*.test.ts`; Node strips the types, so test code — and any app source a test imports — must use erasable TS only, e.g. no constructor parameter properties). `test/support/register.mjs` resolves the app's extensionless and `@shared/*` imports; a test can only import modules whose chain never reaches `electron`.
- Tests use `node:sqlite` (`test/support/db.ts`), not better-sqlite3: postinstall rebuilds that for Electron's ABI, so it won't load under plain Node. WhatsApp-page behaviour is tested against `test/support/mimic-whatsapp.ts` (a small DOM answering the real default selectors, with coordinate clicks).
- Schema changes: declare the current shape in `src/main/db/schema.ts` AND add an additive step to `src/main/db/migrate.ts` (existing databases never re-run CREATE TABLE).
- Anything run inside the WhatsApp `<webview>` goes through `src/renderer/components/whatsapp/guest.ts` as a self-contained function (see `guest-scripts.ts`), never a hand-built `executeJavaScript` string. A guest-side throw otherwise surfaces only as Electron's opaque "Error occurred in handler for 'GUEST_VIEW_MANAGER_CALL': Script failed to execute" in the main log.
- To exercise the live pane without a linked phone (or touching the real session/DB), run with `PA_WHATSAPP_URL` pointed at a local page that mimics WhatsApp's DOM, a separate `PA_WHATSAPP_PARTITION`, and `-- --user-data-dir=<tmp>` (electron-vite passes args after `--` to Electron).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
