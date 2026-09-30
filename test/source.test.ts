// Source capture: every captured message keeps what's needed to find + reply to it later — its
// chat as WhatsApp knows it (the chat JID) and its own message key + sender (src/main/whatsapp/source.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asJid, coerceMessage, messageSource, parseMessageKey } from '../src/main/whatsapp/source.ts'

const GROUP = '120363041234567890@g.us'
const ALICE = '919876543210@c.us'

test('parses WhatsApp message keys: 1:1, group-with-participant, and @lid addressing', () => {
  assert.deepEqual(parseMessageKey(`true_${ALICE}_3EB0A1B2C3D4`), { fromMe: true, chatJid: ALICE, id: '3EB0A1B2C3D4' })
  assert.deepEqual(parseMessageKey(`false_${GROUP}_3A5F0C2B9D_${ALICE}`), { fromMe: false, chatJid: GROUP, id: '3A5F0C2B9D', participant: ALICE })
  assert.deepEqual(parseMessageKey('false_201234567890123@lid_AC12'), { fromMe: false, chatJid: '201234567890123@lid', id: 'AC12' })
})

test('rejects anything that is not a WhatsApp message key', () => {
  for (const id of ['wa_d1', '', 'true_nobody_ABC', `maybe_${ALICE}_ABC`, `true_${ALICE}`, 'true_x@evil.com_ABC', `false_${GROUP}_ABC_not-a-jid`]) {
    assert.equal(parseMessageKey(id), null, id)
  }
  assert.equal(asJid('"><script>@c.us'), null)
  assert.equal(asJid(42), null)
})

test('coerceMessage recovers the chat JID from the message key when the recipe does not report it', () => {
  const m = coerceMessage({
    conversationId: 'family',
    conversationTitle: 'Family',
    messageId: `false_${GROUP}_3A5F0C2B9D_${ALICE}`,
    from: 'Alice',
    direction: 'incoming',
    text: 'Dinner at 8?',
    timestamp: 1000,
    kind: 'text',
    isGroup: false // the DOM path can't tell; the JID can
  })
  assert.ok(m)
  assert.equal(m.chatJid, GROUP)
  assert.equal(m.isGroup, true)
  assert.deepEqual(messageSource(m), { chatJid: GROUP, senderJid: ALICE, status: 'exact' })
})

test('coerceMessage keeps a reported chat JID (store path) and drops a malformed one', () => {
  const base = { conversationId: 'alice', conversationTitle: 'Alice', messageId: 'x_1', text: 'hi', direction: 'incoming' }
  assert.equal(coerceMessage({ ...base, chatJid: ALICE })?.chatJid, ALICE)
  assert.equal(coerceMessage({ ...base, chatJid: 'javascript:alert(1)' })?.chatJid, undefined)
})

test('the sender: a group member from the key, the contact in a 1:1, nobody for the user', () => {
  assert.equal(messageSource({ messageId: `false_${ALICE}_AB`, direction: 'incoming' }).senderJid, ALICE)
  assert.equal(messageSource({ messageId: `true_${ALICE}_AB`, direction: 'outgoing' }).senderJid, null)
  assert.equal(messageSource({ messageId: `false_${GROUP}_AB`, direction: 'incoming' }).senderJid, null) // group, no participant
  assert.deepEqual(messageSource({ messageId: 'wa_d1', direction: 'incoming' }), { chatJid: null, senderJid: null, status: 'title-only' })
})
