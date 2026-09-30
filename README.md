# Jeeves

A WhatsApp Web copilot, as a standalone Electron app. It embeds the real WhatsApp Web in a
sandboxed `<webview>`, reads your chats into topic digests with consolidated action items,
drafts replies for you to review (never sends on its own), and can post a task back into a
group with a real `@mention`.

Extracted from a larger personal-assistant project, keeping only the WhatsApp feature and its
**AI self-heal**: WhatsApp's own DOM markup is not a stable API, so both halves of the
automation are designed to repair themselves when it changes, rather than silently going dark.

## What it does

- **Reads chats** by embedding `web.whatsapp.com` in an Electron `<webview>` on a persistent,
  hardened session partition (own partition, `nodeIntegration` off, `contextIsolation` on).
  Scan the QR once with your phone; the session survives restarts.
- **Extracts topics**, not tickets-per-message: each chat's messages are grouped into a small
  number of "matters" (a title, a 2–3 sentence summary, a status, a priority, tags, and
  consolidated action items), each one referencing the exact messages it came from.
- **Collapses ritual noise** — birthday wishes, good-morning messages, festival greetings,
  "thanks" — into one frequency-counted line per chat instead of letting them pollute topics.
- **Drafts replies** on request. A draft is staged for you to read, edit, copy, or discard; it
  is never sent automatically.
- **Replies to the exact message**: every captured message keeps its source — WhatsApp's own
  chat id and message key, plus the sender — so from a topic's message or action item, **Reply**
  reopens that exact chat, quotes that exact message (WhatsApp's own reply-quote) and puts a draft
  in the message box. You press Send; the app never does. Messages captured before sources were
  kept are recovered from their stored message key where possible, else marked "no source" and
  reopened by chat name.
- **Shows read progress**: while "Read my chats" runs, the banner shows chats read of the total
  (or found so far), messages captured (and how many were new), and the chat being read — then a
  finished or stopped summary with the final counts. There's a Stop button.
- **Assigns a task back into WhatsApp**: posts one line into a group with a real `@mention`
  (not plain "@name" text, which notifies nobody) — always behind an explicit preview + confirm.
- **Transcribes voice notes and describes images** (opt-in, needs a model backend and, for
  voice, a Sarvam key) so they're searchable like text.
- **Runs entirely local-first**: with no LLM backend configured, extraction/drafting fall back
  to a deterministic heuristic rather than doing nothing — the loop stays closable offline.

## The self-heal

WhatsApp Web's markup changes without notice. Two independent pieces of code read/drive it,
and both are stored as **data**, not source, specifically so an AI can safely rewrite them:

1. **The extraction recipe** (`src/main/whatsapp/recipe.ts`) — a self-contained JS string
   injected into the `<webview>` that reads the open chat and reports messages back over
   `console.log`. When it stops capturing (the page has messages but nothing came through),
   the renderer asks the page for a **structure-only diagnostic** (tags/attributes — never
   message text) and `src/main/whatsapp/heal.ts` asks an LLM to rewrite the recipe against it.
2. **UI action selectors** (`src/main/whatsapp/selectors.ts`) — the CSS selectors that drive
   opening a chat, the composer, the send button, the `@mention` popup, and media controls.
   When one can't find its target, the same structure-only-diagnostic pattern asks the LLM for
   **JSON selector strings only** (never code) to fix just the broken ones.

Both paths validate the AI's output before trusting it (the recipe must parse and still emit
its message/state markers; a selector must look like a selector, not code), persist it with
the previous version kept as **last-known-good**, and roll back automatically if the rewrite
doesn't actually fix capture. The regenerated recipe only ever runs inside the sandboxed guest
page — it can never reach Node, the main process, or the rest of the app.

## Setup

```bash
pnpm install        # or npm install
cp .env.example .env
pnpm dev             # electron-vite dev
pnpm test            # unit tests (Node's built-in runner)
```

On first run, the WhatsApp tab shows a QR code — scan it with your phone (WhatsApp → Linked
Devices) to link this session. There's a **Demo mode** toggle for exploring the UI with
scripted sample data and no linked phone at all.

### LLM backend (for extraction, drafting, and self-heal)

`src/main/llm/complete.ts` tries, in order (or as pinned by `PA_LLM_BACKEND`):

1. **Claude Code** — the local `claude` CLI, subscription auth, no API key. Run `claude login`
   once, outside this app, and it's picked up automatically.
2. **OpenAI** — set a key via the in-app secret store, or `PA_OPENAI_KEY` in `.env` for dev.
3. **Anthropic** — set a key via the in-app secret store (`src/main/secrets/keychain.ts`); it
   is never read from a plain env var, by design.

With none configured, extraction and drafting fall back to a plain-heuristic pass, and the
self-heal simply reports it can't fix a break — it never invents a fix without a real model.

### Voice notes (optional)

Voice-note transcription uses Sarvam AI (`src/main/conversation/sarvam.ts`), tuned for Indian
languages and code-mixed speech. Set a Sarvam key via the in-app secret store to enable it;
without one, a voice note is ingested as an untranscribed placeholder.

## Structure

```
src/
  main/            Electron main process — the only privileged surface
    whatsapp/      The feature itself: session, recipe, self-heal, extraction, topics, store
    llm/           The unified small/large-model backend (complete.ts)
    db/            SQLite schema + handle (better-sqlite3, WAL)
    secrets/       OS-keychain-backed secret store
    config/        Runtime config (WhatsApp connection, dev .env loading)
    ipc/           The one IPC handler surface (whatsapp-handlers.ts)
  preload/         The typed IPC bridge — the renderer never sees raw ipcRenderer
  renderer/        React UI: the WhatsApp pane, the Topics view, shadcn/ui primitives
  shared/          ipc-contract.ts — the single source of truth for every IPC channel
```

## Privacy notes

- A structure-only diagnostic (used to drive the self-heal) never includes message text.
- Message content is treated as **untrusted evidence** throughout: extraction and drafting
  prompts explicitly instruct the model never to follow instructions found inside a message.
- A chat can be excluded from analysis entirely (its messages are stored, so you can see them,
  but never sent to a model), or you can set an allow-list so only named chats are analysed at
  all.
- "Delete WhatsApp data" purges every captured message, conversation, and topic — no undo.
