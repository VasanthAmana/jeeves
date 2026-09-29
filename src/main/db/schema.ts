// Local SQLite schema — operational state only. Secrets are safeStorage-encrypted
// blobs (see ../secrets/keychain.ts), never plaintext.

export const SCHEMA_SQL = `
-- Non-secret app-level settings (key/value): the demo toggle, the inclusion allow-list, the
-- extraction recipe + its self-heal history, healed action selectors. Secrets NEVER go here.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  name       TEXT PRIMARY KEY,
  blob       BLOB NOT NULL,                        -- safeStorage-encrypted value
  updated_at INTEGER NOT NULL
);

-- Raw-capture tables for the WhatsApp observation source (WAC-001). Extracted obligations are
-- NOT stored per-message — they ride the topic digest below. Only the raw messages + their
-- conversations are relational. Personal chats can be flagged excluded so the observer never
-- analyses or transmits them.
CREATE TABLE IF NOT EXISTS wa_conversations (
  id           TEXT PRIMARY KEY,                 -- WhatsApp chat id (a hashed/slugged title)
  title        TEXT NOT NULL,
  is_group     INTEGER NOT NULL DEFAULT 0,
  participants TEXT NOT NULL DEFAULT '[]',        -- JSON string[]
  excluded     INTEGER NOT NULL DEFAULT 0,        -- 1 = never analyse / never send to cloud
  last_seen_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,                  -- WhatsApp data-id (dedupe key with conversation_id)
  direction       TEXT NOT NULL,                  -- 'incoming' | 'outgoing' (outgoing = the user's own)
  sender          TEXT,                            -- display name / number
  text            TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT 'text',    -- text|reply|system|reaction|sticker|media|notification
  timestamp       INTEGER NOT NULL,               -- epoch ms of the message
  topic_id        TEXT,                            -- assigned topic (below); NULL until extracted
  topic_pinned    INTEGER NOT NULL DEFAULT 0,      -- a user MOVED it here; re-extraction won't override
  analysis_class  TEXT NOT NULL DEFAULT 'topic',   -- 'topic' (substantive) | 'ritual' (greeting/wish)
  created_at      INTEGER NOT NULL,
  UNIQUE(conversation_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_conv ON wa_messages(conversation_id, timestamp);

-- WhatsApp topic digests. Instead of a ticket per message, extraction produces one TOPIC per
-- matter: a title, summary, status, and its consolidated action items. Keyed by
-- (conversation_id, title-slug) so re-extracting the same thread UPDATES the topic (status,
-- actions) rather than creating duplicates.
CREATE TABLE IF NOT EXISTS wa_topics (
  id                 TEXT PRIMARY KEY,               -- conversation_id + ':' + slug(title)
  conversation_id    TEXT NOT NULL,
  conversation_title TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL,
  summary            TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'open',   -- open | waiting | resolved
  priority           TEXT NOT NULL DEFAULT 'normal',
  tags               TEXT NOT NULL DEFAULT '[]',     -- JSON string[] — grouping/filtering
  priority_locked    INTEGER NOT NULL DEFAULT 0,     -- a user set priority manually; keep it
  tags_locked        INTEGER NOT NULL DEFAULT 0,     -- a user set tags manually; keep them
  action_items       TEXT NOT NULL DEFAULT '[]',     -- JSON [{text,owner,due,type}]
  evidence           TEXT NOT NULL DEFAULT '[]',     -- JSON message-id[]
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_topics_conv ON wa_topics(conversation_id, updated_at);

-- "Group activity" digest: ritual/greeting messages (birthday wishes, good-morning/night,
-- festival greetings, thanks) or any short text repeated by many senders, collapsed into ONE
-- frequency-counted line per kind, so they never pollute topics/action items. Rebuilt from a
-- recent window by the analysis batch. Keyed by (conversation_id, kind).
CREATE TABLE IF NOT EXISTS wa_activity (
  id                 TEXT PRIMARY KEY,               -- conversation_id + ':' + kind
  conversation_id    TEXT NOT NULL,
  conversation_title TEXT NOT NULL DEFAULT '',
  kind               TEXT NOT NULL,                  -- birthday|good_morning|...|cluster:<hash>
  emoji              TEXT NOT NULL DEFAULT '💬',
  label              TEXT NOT NULL,
  sender_count       INTEGER NOT NULL DEFAULT 0,     -- distinct senders (the headline number)
  msg_count          INTEGER NOT NULL DEFAULT 0,     -- total messages in the cluster
  senders            TEXT NOT NULL DEFAULT '[]',     -- JSON sample sender names
  first_ts           INTEGER,
  last_ts            INTEGER,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wa_activity_conv ON wa_activity(conversation_id, last_ts);
`
