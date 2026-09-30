// The reply-open path (src/renderer/components/whatsapp/reply-stager.ts), driven against a mimic
// WhatsApp Web page: a stored message's source reopens its exact chat, quotes that exact message and
// stages the draft in the message box — and nothing is ever sent. Each fallback says what happened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MimicWhatsApp, type MimicChat } from './support/mimic-whatsapp.ts'
import { freshDb } from './support/db.ts'
import { createGuest } from '../src/renderer/components/whatsapp/guest.ts'
import { stageReply, type StageDeps } from '../src/renderer/components/whatsapp/reply-stager.ts'
import { DEFAULT_SELECTORS } from '../src/main/whatsapp/selector-defaults.ts'
import { coerceMessage } from '../src/main/whatsapp/source.ts'
import { insertMessage, setExcluded, upsertConversation } from '../src/main/whatsapp/store.ts'
import { resolveReplyTarget } from '../src/main/whatsapp/reply.ts'
import type { WaReplyPlan, WaReplyTarget } from '../src/shared/ipc-contract.ts'

const SITE = '120363041234567890@g.us'
const OTHER_SITE = '120363099999999999@g.us'
const ALICE = '919876543210@c.us'
const BOB = '917777777777@c.us'
const FAMILY = '919000000000-1600000000@g.us'

const ask = { dataId: `false_${SITE}_3A01_${ALICE}`, sender: 'Alice', text: 'Can you send the revised quote by Friday?' }
const old = { dataId: `false_${SITE}_3A00_${BOB}`, sender: 'Bob', text: 'Kick-off notes are in the drive', loaded: false }

function chats(): MimicChat[] {
  return [
    { jid: 'status@broadcast', title: 'Announcements', messages: [] },
    { jid: SITE, title: 'Site Team', messages: [old, ask, { dataId: `true_${SITE}_3EB0FF`, sender: 'me', text: 'On it' }] },
    { jid: FAMILY, title: 'Family', messages: [{ dataId: `false_${FAMILY}_AA1_${BOB}`, sender: 'Appa', text: 'Dinner at 8?' }], onScreen: false }
  ]
}

function deps(page: MimicWhatsApp): StageDeps {
  const guest = createGuest(page.webview(), () => undefined)
  guest.setReady(true)
  return {
    guest,
    sels: () => ({ ...DEFAULT_SELECTORS }),
    click: (p) => page.click(p, 'left'),
    rightClick: (p) => page.click(p, 'right'),
    escape: () => page.key('Escape'),
    sleep: async () => undefined
  }
}

/** The plan exactly as main builds it (wa:prepareReply), from what the store captured. */
function planFor(target: WaReplyTarget, captured: Record<string, unknown>[], draft = 'Yes — sending it Thursday.'): WaReplyPlan {
  const db = freshDb()
  for (const raw of captured) {
    const m = coerceMessage(raw)
    assert.ok(m)
    upsertConversation(db, m, 1)
    insertMessage(db, m, 1)
  }
  const r = resolveReplyTarget(db, target)
  assert.ok(r.ok, r.ok ? '' : r.error)
  return { ...r.dest, draft }
}

const captured = (chatTitle: string, m: { dataId: string; sender: string; text: string }): Record<string, unknown> => ({
  conversationId: chatTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  conversationTitle: chatTitle,
  messageId: m.dataId,
  from: m.dataId.startsWith('true_') ? 'me' : m.sender,
  direction: m.dataId.startsWith('true_') ? 'outgoing' : 'incoming',
  text: m.text,
  timestamp: 1000,
  kind: 'text'
})

test('opens the exact chat, quotes the exact message, stages the draft — and sends nothing', async () => {
  const page = new MimicWhatsApp(chats())
  const plan = planFor({ conversationId: 'site-team', messageId: ask.dataId }, [captured('Site Team', ask)])
  assert.equal(plan.chatJid, SITE)
  assert.equal(plan.quote?.messageId, ask.dataId)

  const r = await stageReply(deps(page), plan)

  assert.deepEqual(r, { opened: true, quoted: true, staged: true })
  assert.equal(page.openJid, SITE)
  assert.equal(page.quote?.dataId, ask.dataId) // WhatsApp's own reply-quote of that exact message
  assert.equal(page.composer, 'Yes — sending it Thursday.')
  assert.deepEqual(page.sent, []) // staged only: the user presses Send
  assert.ok(page.clicks.every((c) => c.hit !== 'Send'))
  assert.ok(!page.keys.includes('Enter'))
  assert.deepEqual(
    page.clicks.map((c) => [c.button, c.hit]),
    [
      ['left', 'row'], // the chat in the list
      ['right', ask.dataId], // the message's menu
      ['left', 'button'] // its "Reply" item
    ]
  )
})

test('a chat that is not on screen is found through the chat-list search, which is cleared after', async () => {
  const page = new MimicWhatsApp(chats())
  const m = chats()[2].messages[0]
  const plan = planFor({ conversationId: 'family', messageId: m.dataId }, [captured('Family', m)])

  const r = await stageReply(deps(page), plan)

  assert.deepEqual(r, { opened: true, quoted: true, staged: true })
  assert.equal(page.openJid, FAMILY)
  assert.equal(page.search, '')
  assert.deepEqual(page.sent, [])
})

test('a same-named chat that is not the message’s chat is not staged into', async () => {
  const page = new MimicWhatsApp([
    { jid: OTHER_SITE, title: 'Site Team', messages: [{ dataId: `false_${OTHER_SITE}_ZZ1_${BOB}`, sender: 'Bob', text: 'Other site' }] },
    ...chats()
  ])
  const plan = planFor({ conversationId: 'site-team', messageId: ask.dataId }, [captured('Site Team', ask)])

  const r = await stageReply(deps(page), plan)

  assert.equal(r.opened, true)
  assert.equal(r.staged, false)
  assert.match(r.note ?? '', /isn't the chat the message came from/)
  assert.equal(page.composer, '')
  assert.deepEqual(page.sent, [])
})

test('a message no longer loaded in the chat: opens the chat and stages the draft, and says it could not quote', async () => {
  const page = new MimicWhatsApp(chats())
  const plan = planFor({ conversationId: 'site-team', messageId: old.dataId }, [captured('Site Team', old), captured('Site Team', ask)])

  const r = await stageReply(deps(page), plan)

  assert.equal(r.opened, true)
  assert.equal(r.quoted, false)
  assert.equal(r.staged, true)
  assert.match(r.note ?? '', /isn’t loaded in the chat/)
  assert.equal(page.quote, null)
  assert.equal(page.composer, 'Yes — sending it Thursday.')
  assert.deepEqual(page.sent, [])
})

test('when the message menu has no Reply, it is closed again and the draft is staged unquoted', async () => {
  const page = new MimicWhatsApp(chats())
  page.menuHasReply = false
  const plan = planFor({ conversationId: 'site-team', messageId: ask.dataId }, [captured('Site Team', ask)])

  const r = await stageReply(deps(page), plan)

  assert.deepEqual([r.opened, r.quoted, r.staged], [true, false, true])
  assert.match(r.note ?? '', /no “Reply” option/)
  assert.equal(page.menu, null)
  assert.deepEqual(page.keys, ['Escape'])
  assert.deepEqual(page.sent, [])
})

test('never overwrites text the user already has in the message box', async () => {
  const page = new MimicWhatsApp(chats())
  page.openJid = SITE
  page.composer = 'half-typed thought'
  page.render()
  const plan = planFor({ conversationId: 'site-team', messageId: ask.dataId }, [captured('Site Team', ask)])

  const r = await stageReply(deps(page), plan)

  assert.equal(r.staged, false)
  assert.match(r.note ?? '', /already has text/)
  assert.equal(page.composer, 'half-typed thought')
  assert.deepEqual(page.sent, [])
})

test('a message saved before sources were kept still reopens its chat by name, and says why it can’t be quoted', async () => {
  const page = new MimicWhatsApp(chats())
  // An older capture: no WhatsApp message key, so no chat JID — status 'title-only'.
  const plan = planFor({ conversationId: 'site-team', messageId: 'legacy-1' }, [
    { conversationId: 'site-team', conversationTitle: 'Site Team', messageId: 'legacy-1', from: 'Alice', direction: 'incoming', text: 'Quote?', timestamp: 1 }
  ])
  assert.equal(plan.quote?.status, 'title-only')
  assert.equal(plan.chatJid, null)

  const r = await stageReply(deps(page), plan)

  assert.deepEqual([r.opened, r.quoted, r.staged], [true, false, true])
  assert.match(r.note ?? '', /saved before Jeeves kept message sources/)
  assert.equal(page.openJid, SITE)
  assert.deepEqual(page.sent, [])
})

test('a chat that cannot be found is reported, with nothing staged anywhere', async () => {
  const page = new MimicWhatsApp(chats())
  const plan: WaReplyPlan = { conversationId: 'gone', chatTitle: 'Gone Chat', chatJid: null, quote: null, draft: 'hi' }

  const r = await stageReply(deps(page), plan)

  assert.deepEqual([r.opened, r.quoted, r.staged], [false, false, false])
  assert.match(r.note ?? '', /Couldn't open “Gone Chat”/)
  assert.equal(page.openJid, null)
  assert.equal(page.search, '')
  assert.deepEqual(page.sent, [])
})

test('an excluded chat is never drafted for (its messages must not reach a model)', () => {
  const db = freshDb()
  const m = coerceMessage(captured('Site Team', ask))
  assert.ok(m)
  upsertConversation(db, m, 1)
  insertMessage(db, m, 1)
  setExcluded(db, 'site-team', true)
  assert.deepEqual(resolveReplyTarget(db, { conversationId: 'site-team', messageId: ask.dataId }), {
    ok: false,
    error: 'This chat is excluded from analysis, so no reply is drafted for it.'
  })
  assert.equal(resolveReplyTarget(db, { conversationId: 'site-team', messageId: 'nope' }).ok, false)
})

test('an outgoing message whose quote never attached is not reported quoted just because the footer says "you"', async () => {
  const page = new MimicWhatsApp(chats())
  page.replyAttachesQuote = false
  page.footerHint = 'Would you like to add a caption?'
  const mine = chats()[1].messages[2]
  const plan = planFor({ conversationId: 'site-team', messageId: mine.dataId }, [captured('Site Team', mine)])

  const r = await stageReply(deps(page), plan)

  assert.equal(page.quote, null)
  assert.equal(r.quoted, false)
  assert.match(r.note ?? '', /couldn’t confirm the quote/)
  assert.deepEqual(page.sent, [])
})

test('a quoted message longer than 40 characters, cut mid-word for matching, is still confirmed as quoted', async () => {
  const page = new MimicWhatsApp(chats())
  const long = { dataId: `false_${SITE}_3A09_${ALICE}`, sender: 'Al', text: 'Kindly confirm the delivery schedules for tomorrow' }
  page.chats[1].messages.push(long)
  assert.ok(long.text.slice(0, 40).endsWith('schedules fo'))
  const plan = planFor({ conversationId: 'site-team', messageId: long.dataId }, [captured('Site Team', long)])

  const r = await stageReply(deps(page), plan)

  assert.equal(page.quote?.dataId, long.dataId)
  assert.equal(r.quoted, true)
})
