import { getSetting, setSetting } from '../db/settings'

// The extraction RECIPE (WAC-004 + WAC-019) — a self-contained JS string injected into the
// WhatsApp Web <webview>. Storing extraction as DATA (not source) is the safety boundary the
// AI-heal needs: a regenerated recipe is a new string executed ONLY inside the sandboxed guest
// page (separate process, contextIsolation on, own partition — it cannot reach Node/main/other
// app code), validated + rolled back on failure. The AI can never edit source or run in the app.
//
// The recipe reports over console.log (the one-way bridge, no preload):
//   __WA_MSG__<json>     one captured message {conversationId,conversationTitle,messageId,from,
//                        direction:'incoming'|'outgoing',text,timestamp,kind,isGroup}
//   __WA_STATE__<state>  'linked' | 'qr' | 'unauthenticated'
//   __WA_HEALTH__<json>  {linked, domMsgs, captured, storeChats} — lets the app detect "page has
//                        messages but we captured 0" = broken → trigger AI-heal
//   __WA_DIAG__<json>    STRUCTURE-ONLY snapshot (tags/classes/attrs/store keys — never message
//                        text) emitted when window.__WA_DIAG_REQUEST is set, for the AI-heal input
//
// WAC-019: it reads the open chat via the DOM AND attempts WhatsApp's internal module store
// (already-loaded module CACHE only — never instantiates modules, so no side effects) to recover
// UNOPENED chats without opening them (no read receipts). The store hook is inherently fragile
// (obfuscated, per-build) — which is exactly what the AI-heal repairs.

const RECIPE_SETTING = 'wa_recipe'
const RECIPE_PREV_SETTING = 'wa_recipe_prev'
const RECIPE_VER_SETTING = 'wa_recipe_version'
const RECIPE_BASE_SETTING = 'wa_recipe_base'
// BUMP whenever DEFAULT_RECIPE gains a capability (voice, image, new selectors, …). A persisted
// self-heal is only reused when it was derived from the CURRENT code base — otherwise a heal from
// an older build would shadow the newly-shipped default forever (this is exactly what hid the image
// branch during testing). On mismatch we fall back to DEFAULT_RECIPE, which re-heals if it breaks.
const RECIPE_CODE_VERSION = '2-media'

export const DEFAULT_RECIPE = String.raw`(() => {
  if (window.__waCopilot) return; window.__waCopilot = true;
  var seen = new Set(); var captured = 0;
  var out = function (o) { try { console.log('__WA_MSG__' + JSON.stringify(o)); captured++; } catch (e) {} };
  var st = function (s) { try { console.log('__WA_STATE__' + s); } catch (e) {} };
  var sendAudio = function (o) { try { console.log('__WA_AUDIO__' + JSON.stringify(o)); } catch (e) {} };
  var slug = function (s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat'; };

  var closeIntro = function () { document.querySelectorAll('[role="dialog"]').forEach(function (d) { if (/what.?s new|download whatsapp|get a faster experience/i.test(d.innerText || '')) { var b = d.querySelector('button[aria-label="Close"], button[aria-label*="Close" i], div[aria-label="Close"]'); if (b) b.click(); } }); };
  var chatName = function () { var h = document.querySelector('#main header'); if (!h) return ''; var l = (h.innerText || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean); return l[0] || ''; };
  var preParse = function (el) { var cp = el.querySelector('.copyable-text'); var meta = cp ? (cp.getAttribute('data-pre-plain-text') || '') : ''; var m = meta.match(/^\[(.*?)\]\s*([^:]*):/); var ts = Date.now(); if (m) { var d = new Date(m[1].replace(',', '')); if (!isNaN(d.getTime())) ts = d.getTime(); } return { sender: m ? m[2].trim() : '', ts: ts }; };
  var myName = function () { var o = document.querySelector('#main div[data-id] [data-icon="tail-out"]'); var row = o && o.closest('div[data-id]'); return row ? preParse(row).sender : ''; };

  // ── WAC-004: DOM read of the currently-open chat ──────────────────────────────────
  var scanDom = function () {
    var name = chatName(); if (!name) return 0;
    var convId = slug(name); var mine = myName(); var n = 0;
    document.querySelectorAll('#main div[data-id]').forEach(function (el) {
      var id = el.getAttribute('data-id'); if (!id || seen.has(id)) return;
      var p = preParse(el); var dir;
      if (el.querySelector('[data-icon="tail-out"]')) dir = 'outgoing';
      else if (el.querySelector('[data-icon="tail-in"]')) dir = 'incoming';
      else dir = (mine && p.sender && p.sender === mine) ? 'outgoing' : 'incoming';
      var base = { conversationId: convId, conversationTitle: name, messageId: id, from: dir === 'outgoing' ? 'me' : (p.sender || 'unknown'), direction: dir, timestamp: p.ts, isGroup: false };
      var sel = el.querySelector('.selectable-text');
      var text = sel ? (sel.innerText || sel.textContent || '').trim() : '';
      if (text) { seen.add(id); n++; out(Object.assign({}, base, { text: text, kind: 'text' })); return; }
      // ── WAC-021: media (no readable bytes in the DOM — WhatsApp decodes opus in WASM and only
      // previews images). Signal the renderer to arm context + trigger WhatsApp's own Download for
      // the row; the main-process interceptor grabs the decrypted file. mediaKind picks the pipeline.
      if (!window.__WA_AUDIO_READ) return;
      var isVoice = !!el.querySelector('[data-icon="ptt-status"], [data-icon="audio-play"], [data-icon="audio-pause"], [data-icon="ptt"], button[aria-label*="voice message" i], button[aria-label*="Play voice" i]');
      if (isVoice) { seen.add(id); n++; sendAudio(Object.assign({}, base, { need: 'download', mediaKind: 'voice' })); return; }
      // photo message: a sizeable blob-backed image (excludes tiny avatars/stickers, videos, docs).
      // For now we only note that a photo was shared — enough context for a topic/action item — and
      // skip vision OCR (the wa:describeImage path stays available for when text-from-image is wanted).
      var img = el.querySelector('img[src^="blob:"]');
      var isPhoto = !!img && (img.getBoundingClientRect().width > 80 || img.naturalWidth > 150) && !el.querySelector('[data-icon="media-play"], [data-icon="video"], span[data-icon="audio-download"]');
      if (isPhoto) { seen.add(id); n++; out(Object.assign({}, base, { text: '📷 shared a photo', kind: 'media' })); return; }
    });
    return n;
  };

  // ── WAC-019: internal-store read of ALL chats (best-effort, cache-scan only) ───────
  // Gets WhatsApp's webpack require via a fake chunk push (no module instantiation), then scans
  // the ALREADY-LOADED module cache for a Chat store. Reads recent msgs per chat WITHOUT opening
  // them (no read receipts). Heavily guarded — any failure silently yields the DOM path.
  var storeChats = 0;
  var getStore = function () {
    try {
      if (window.__WA_ST !== undefined) return window.__WA_ST;
      window.__WA_ST = null;
      var pn = Object.keys(window).filter(function (k) { return /^webpackChunk/.test(k); })[0];
      if (!pn) return null;
      var req;
      try { window[pn].push([['__wac_' + Date.now()], {}, function (r) { req = r; }]); } catch (e) {}
      if (!req || !req.c) return null;
      for (var id in req.c) {
        try {
          var ex = req.c[id] && req.c[id].exports; if (!ex) continue;
          var cand = ex.Chat || (ex.default && ex.default.Chat);
          if (cand && (cand.getModelsArray || cand._models)) { window.__WA_ST = ex.Chat ? ex : ex.default; return window.__WA_ST; }
        } catch (e) {}
      }
    } catch (e) {}
    return window.__WA_ST || null;
  };
  var scanStore = function () {
    try {
      var S = getStore(); if (!S || !S.Chat) return;
      var chats = (S.Chat.getModelsArray && S.Chat.getModelsArray()) || S.Chat._models || [];
      storeChats = chats.length; var cap = 0;
      for (var i = 0; i < chats.length && cap < 400; i++) {
        var c = chats[i]; if (!c) continue;
        var jid = (c.id && (c.id._serialized || c.id.toString && c.id.toString())) || '';
        var isGroup = /@g\.us$/.test(jid);
        var title = c.formattedTitle || c.name || (c.contact && c.contact.formattedName) || jid || 'chat';
        var convId = slug(title);
        var msgs = (c.msgs && (c.msgs.getModelsArray ? c.msgs.getModelsArray() : c.msgs._models)) || [];
        for (var j = Math.max(0, msgs.length - 25); j < msgs.length; j++) {
          var m = msgs[j]; if (!m) continue; cap++;
          var mid = (m.id && (m.id._serialized || (m.id.id))) || (jid + '_' + j);
          if (seen.has(mid)) continue;
          var body = m.body || m.caption || ''; if (!body || typeof body !== 'string') continue;
          var fromMe = !!m.id && (m.id.fromMe !== undefined ? m.id.fromMe : m.fromMe);
          var sender = fromMe ? 'me' : ((m.senderObj && (m.senderObj.formattedName || m.senderObj.pushname)) || (m.author && String(m.author)) || title);
          var ts = (m.t ? m.t * 1000 : Date.now());
          seen.add(mid);
          out({ conversationId: convId, conversationTitle: title, messageId: String(mid), from: fromMe ? 'me' : String(sender), direction: fromMe ? 'outgoing' : 'incoming', text: String(body), timestamp: ts, kind: 'text', isGroup: isGroup });
        }
      }
    } catch (e) {}
  };

  var state = function () { if (document.querySelector('#pane-side')) st('linked'); else if (document.querySelector('canvas') || document.querySelector('[data-ref]')) st('qr'); else st('unauthenticated'); };
  var health = function (domN) { try { console.log('__WA_HEALTH__' + JSON.stringify({ linked: !!document.querySelector('#pane-side'), domMsgs: document.querySelectorAll('#main div[data-id]').length, captured: captured, storeChats: storeChats, domTick: domN })); } catch (e) {} };

  // Structure-only diagnostic for the AI-heal — NEVER includes message text (privacy, WAC-016/017).
  var diag = function () {
    try {
      var sampleRow = document.querySelector('#main div[data-id]');
      var attrsOf = function (el) { if (!el) return null; var a = {}; for (var i = 0; i < el.attributes.length; i++) { var n = el.attributes[i].name; a[n] = n === 'class' ? (el.className || '').slice(0, 80) : (n === 'data-id' ? '<id>' : (el.getAttribute(n) || '').slice(0, 40)); } return { tag: el.tagName, attrs: a, childTags: [].slice.call(el.children).slice(0, 6).map(function (c) { return c.tagName; }) }; };
      var snap = {
        linked: !!document.querySelector('#pane-side'),
        hasMain: !!document.querySelector('#main'),
        domMsgRows: document.querySelectorAll('#main div[data-id]').length,
        headerFirstLineExists: !!(document.querySelector('#main header') && document.querySelector('#main header').innerText),
        iconAttrsPresent: { tailOut: !!document.querySelector('[data-icon="tail-out"]'), tailIn: !!document.querySelector('[data-icon="tail-in"]') },
        copyablePresent: !!document.querySelector('#main .copyable-text[data-pre-plain-text]'),
        selectablePresent: !!document.querySelector('#main .selectable-text'),
        sampleMessageRow: attrsOf(sampleRow),
        paneSideRowRole: (document.querySelector('#pane-side [role="row"]') ? 'role=row' : (document.querySelector('#pane-side [role="listitem"]') ? 'role=listitem' : 'unknown')),
        webpackChunkKeys: Object.keys(window).filter(function (k) { return /^webpackChunk/.test(k); }),
        storeHookFound: !!(window.__WA_ST && window.__WA_ST.Chat),
        storeChats: storeChats
      };
      console.log('__WA_DIAG__' + JSON.stringify(snap));
    } catch (e) { try { console.log('__WA_DIAG__' + JSON.stringify({ error: String(e) })); } catch (e2) {} }
  };
  window.__waDiag = diag;

  var storeTried = false;
  var tick = function () {
    closeIntro();
    var domN = scanDom();
    if (window.__WA_STORE_READ && !storeTried) { storeTried = true; scanStore(); }
    state(); health(domN);
    if (window.__WA_DIAG_REQUEST) { window.__WA_DIAG_REQUEST = false; diag(); }
  };
  var t; var deb = function () { clearTimeout(t); t = setTimeout(tick, 800); };
  new MutationObserver(deb).observe(document.body, { childList: true, subtree: true });
  setInterval(tick, 5000);
  tick();
})();`

/** The active recipe: a persisted heal ONLY if derived from the current code base, else the default. */
export function getRecipe(): string {
  const persisted = getSetting(RECIPE_SETTING)
  if (persisted && getSetting(RECIPE_BASE_SETTING) === RECIPE_CODE_VERSION) return persisted
  return DEFAULT_RECIPE // no heal, or a heal from an older build → use the freshly-shipped default
}

/** Persist a new recipe (keeping the previous as last-known-good for rollback) + bump version. */
export function setRecipe(js: string): void {
  const cur = getSetting(RECIPE_SETTING)
  if (cur) setSetting(RECIPE_PREV_SETTING, cur)
  setSetting(RECIPE_SETTING, js)
  setSetting(RECIPE_BASE_SETTING, RECIPE_CODE_VERSION) // stamp the code base this heal was derived from
  const v = Number(getSetting(RECIPE_VER_SETTING) ?? '0') + 1
  setSetting(RECIPE_VER_SETTING, String(v))
}

/** Roll back to the last-known-good recipe (or the built-in default if none). */
export function rollbackRecipe(): string {
  const prev = getSetting(RECIPE_PREV_SETTING)
  if (prev) {
    setSetting(RECIPE_SETTING, prev)
    return prev
  }
  setSetting(RECIPE_SETTING, DEFAULT_RECIPE)
  return DEFAULT_RECIPE
}

export function recipeInfo(): { version: number; healed: boolean } {
  return { version: Number(getSetting(RECIPE_VER_SETTING) ?? '0'), healed: !!getSetting(RECIPE_SETTING) }
}
