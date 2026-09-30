// Stored messages keep their source, topic evidence resolves to it, and a database from before
// sources were kept migrates additively (src/main/whatsapp/store.ts, topics-store.ts, db/migrate.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { freshDb, rawDb } from './support/db.ts'
import { SCHEMA_SQL } from '../src/main/db/schema.ts'
import { migrate, SCHEMA_VERSION } from '../src/main/db/migrate.ts'
import { insertMessage, recentMessages, resolveSource, resolveSources, upsertConversation, conversationSource } from '../src/main/whatsapp/store.ts'
import { listTopics, upsertTopic } from '../src/main/whatsapp/topics-store.ts'
import { coerceMessage } from '../src/main/whatsapp/source.ts'
import type { NormalizedMessage } from '../src/shared/ipc-contract.ts'

const GROUP = '120363041234567890@g.us'
const ALICE = '919876543210@c.us'
const ME = '918888888888@c.us'

function ingest(db: ReturnType<typeof freshDb>, raw: Record<string, unknown>): NormalizedMessage {
  const msg = coerceMessage(raw)
  assert.ok(msg)
  upsertConversation(db, msg, 1)
  insertMessage(db, msg, 1)
  return msg
}

const groupMsg = (id: string, from: string, text: string, ts: number, participant = ALICE): Record<string, unknown> => ({
  conversationId: 'site-team',
  conversationTitle: 'Site Team',
  messageId: `false_${GROUP}_${id}_${participant}`,
  from,
  direction: 'incoming',
  text,
  timestamp: ts,
  kind: 'text'
})

test('a captured message is stored with its exact source and read back with it', () => {
  const db = freshDb()
  ingest(db, groupMsg('3A01', 'Alice', 'Can you send the revised quote?', 100))
  ingest(db, { conversationId: 'site-team', conversationTitle: 'Site Team', messageId: `true_${GROUP}_3EB0FF`, from: 'me', direction: 'outgoing', text: 'Sure, by Friday', timestamp: 200 })

  const [asked, answered] = recentMessages(db, 'site-team')
  assert.deepEqual(asked.source, {
    conversationId: 'site-team',
    chatTitle: 'Site Team',
    chatJid: GROUP,
    messageId: `false_${GROUP}_3A01_${ALICE}`,
    sender: 'Alice',
    senderJid: ALICE,
    direction: 'incoming',
    text: 'Can you send the revised quote?',
    timestamp: 100,
    status: 'exact'
  })
  assert.equal(answered.source.senderJid, null)
  assert.equal(answered.source.status, 'exact')
  assert.deepEqual(conversationSource(db, 'site-team'), { title: 'Site Team', chatJid: GROUP })
  // The DOM path reports isGroup:false; the JID says otherwise.
  assert.equal((db.prepare('SELECT is_group FROM wa_conversations WHERE id = ?').get('site-team') as { is_group: number }).is_group, 1)
})

test('a message with no WhatsApp key (demo data) is kept, and marked title-only', () => {
  const db = freshDb()
  ingest(db, { conversationId: 'family', conversationTitle: 'Family', messageId: 'wa_f1', from: 'Amma', direction: 'incoming', text: 'Dinner at 8?', timestamp: 5 })
  const src = resolveSource(db, 'family', 'wa_f1')
  assert.equal(src?.status, 'title-only')
  assert.equal(src?.chatJid, null)
  assert.equal(src?.chatTitle, 'Family')
})

test('topic action evidence resolves to the exact chat + message; unknown ids are dropped', () => {
  const db = freshDb()
  const a = ingest(db, groupMsg('3A01', 'Alice', 'Can you send the revised quote?', 100))
  const b = ingest(db, groupMsg('3A02', 'Bob', 'Also the site visit on Monday?', 150, ME))
  upsertTopic(
    db,
    'site-team',
    'Site Team',
    {
      id: '',
      title: 'Revised quote',
      summary: '',
      status: 'open',
      priority: 'normal',
      tags: [],
      actionItems: [
        { type: 'reply_required', text: 'Send the revised quote', evidence_message_ids: [a.messageId, 'made-up-id'] },
        { type: 'meeting_date', text: 'Confirm Monday site visit', evidence_message_ids: [b.messageId] },
        { type: 'user_commitment', text: 'An action stored before evidence was kept' }
      ],
      messageIds: [a.messageId, b.messageId]
    },
    300
  )
  const [topic] = listTopics(db)
  assert.deepEqual(
    topic.action_items.map((x) => x.evidence.map((e) => [e.chatJid, e.messageId, e.sender])),
    [[[GROUP, a.messageId, 'Alice']], [[GROUP, b.messageId, 'Bob']], []]
  )
  assert.deepEqual(
    topic.messages.map((m) => [m.message_id, m.source.chatJid, m.source.status]),
    [
      [a.messageId, GROUP, 'exact'],
      [b.messageId, GROUP, 'exact']
    ]
  )
  // Evidence ids are scoped to the topic's own chat.
  assert.deepEqual(resolveSources(db, 'another-chat', [a.messageId]), [])
})

test('a database from before sources were kept migrates additively and stays readable', () => {
  const db = rawDb()
  db.exec(readFileSync(new URL('./fixtures/schema-before-sources.sql', import.meta.url), 'utf8'))
  const conv = db.prepare('INSERT INTO wa_conversations (id, title, is_group, created_at, last_seen_at) VALUES (?, ?, ?, 1, ?)')
  conv.run('site-team', 'Site Team', 0, 200)
  conv.run('family', 'Family', 1, 50)
  const msg = db.prepare(
    'INSERT INTO wa_messages (conversation_id, message_id, direction, sender, text, timestamp, topic_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
  )
  msg.run('site-team', `false_${GROUP}_3A01_${ALICE}`, 'incoming', 'Alice', 'Quote?', 100, 'site-team:quote')
  msg.run('site-team', `true_${GROUP}_3EB0FF`, 'outgoing', 'me', 'Friday', 200, null)
  msg.run('family', 'wa_f1', 'incoming', 'Amma', 'Dinner at 8?', 50, null)

  // Open it the way the app does (db/index.ts): current schema (a no-op on existing tables), then migrate.
  db.exec(SCHEMA_SQL)
  migrate(db)
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION)

  const recovered = resolveSource(db, 'site-team', `false_${GROUP}_3A01_${ALICE}`)
  assert.equal(recovered?.status, 'recovered')
  assert.equal(recovered?.chatJid, GROUP)
  assert.equal(recovered?.senderJid, ALICE)
  assert.equal(resolveSource(db, 'site-team', `true_${GROUP}_3EB0FF`)?.status, 'recovered')
  assert.deepEqual(conversationSource(db, 'site-team'), { title: 'Site Team', chatJid: GROUP })

  const legacy = resolveSource(db, 'family', 'wa_f1')
  assert.equal(legacy?.status, 'title-only') // no source to recover — still readable, marked as such
  assert.equal(legacy?.text, 'Dinner at 8?')
  assert.deepEqual(conversationSource(db, 'family'), { title: 'Family', chatJid: null })
  // Nothing else about the old rows changed.
  assert.equal((db.prepare('SELECT topic_id FROM wa_messages WHERE message_id = ?').get(`false_${GROUP}_3A01_${ALICE}`) as { topic_id: string }).topic_id, 'site-team:quote')

  // Idempotent: re-opening doesn't re-run or disturb anything, and new captures are 'exact'.
  migrate(db)
  ingest(db, groupMsg('3A09', 'Alice', 'Thanks!', 400))
  assert.equal(resolveSource(db, 'site-team', `false_${GROUP}_3A09_${ALICE}`)?.status, 'exact')
  assert.equal(resolveSource(db, 'family', 'wa_f1')?.status, 'title-only')
})
