import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { net } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { getSecret } from '../secrets/keychain'
import { ANTHROPIC_KEY_SECRET, OPENAI_KEY_SECRET } from '../secrets/names'

// Unified LLM backend (Claude-Code-first). One helper the app's extraction/draft/self-heal
// calls route through, resolving a backend by availability so nothing is hardcoded to a single
// provider:
//   1. Claude Code  — the local `claude` CLI (subscription auth, NO API key). Heavy per call
//      (loads the agent), so used with the small model for extraction. Requires the user to have
//      run `claude login` independently (ToS: we never prompt login in-app).
//   2. OpenAI       — cheapest capable API tier (gpt-5-mini/nano) via net.fetch; needs a key.
//   3. Anthropic    — the @anthropic-ai/sdk path; needs an anthropic key.
//   4. null         — caller falls back to its heuristic.
// Order is PA_LLM_BACKEND (claude-code|openai|anthropic|auto) or auto (the list above).

export type Tier = 'small' | 'large' // small = extraction/draft; large = self-heal (harder)

const MODELS = {
  'claude-code': { small: process.env.PA_CC_MODEL ?? 'claude-haiku-4-5', large: process.env.PA_CC_MODEL_LARGE ?? 'claude-opus-4-8' },
  openai: { small: process.env.PA_OPENAI_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini', large: process.env.PA_OPENAI_MODEL_LARGE ?? 'gpt-4o' },
  anthropic: { small: 'claude-haiku-4-5', large: 'claude-opus-4-8' }
}

// ── Backend availability ──────────────────────────────────────────────────────────────
let _claudeBin: string | null | undefined
/** Resolve the `claude` binary (GUI apps often lack ~/.local/bin on PATH — check known spots). */
function claudeBin(): string | null {
  if (_claudeBin !== undefined) return _claudeBin
  const candidates = [
    process.env.PA_CLAUDE_BIN,
    join(homedir(), '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    join(homedir(), '.claude/local/claude')
  ].filter(Boolean) as string[]
  _claudeBin = candidates.find((p) => existsSync(p)) ?? null
  return _claudeBin
}
function openaiKey(): string | null {
  try {
    return getSecret(OPENAI_KEY_SECRET) || process.env.OPENAI_API_KEY || process.env.PA_OPENAI_KEY || null
  } catch {
    return process.env.OPENAI_API_KEY ?? null
  }
}
function anthropicKey(): string | null {
  try {
    return getSecret(ANTHROPIC_KEY_SECRET) || null
  } catch {
    return null
  }
}

function backendOrder(): ('claude-code' | 'openai' | 'anthropic')[] {
  const pref = (process.env.PA_LLM_BACKEND ?? 'auto').toLowerCase()
  if (pref === 'claude-code') return ['claude-code']
  if (pref === 'openai') return ['openai']
  if (pref === 'anthropic') return ['anthropic']
  const order: ('claude-code' | 'openai' | 'anthropic')[] = []
  if (claudeBin()) order.push('claude-code')
  if (openaiKey()) order.push('openai')
  if (anthropicKey()) order.push('anthropic')
  return order
}

/** True when SOME LLM backend is available (else callers should go straight to heuristics). */
export function llmAvailable(): boolean {
  return backendOrder().length > 0
}

// ── Backend calls (all return plain text) ───────────────────────────────────────────────
function runClaude(system: string, user: string, model: string): Promise<string | null> {
  const bin = claudeBin()
  if (!bin) return Promise.resolve(null)
  return new Promise((resolve) => {
    let out = ''
    const p = spawn(bin, ['-p', '--model', model, '--output-format', 'json'], { env: { ...process.env } })
    const timer = setTimeout(() => { p.kill(); resolve(null) }, 90_000)
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('error', () => { clearTimeout(timer); resolve(null) })
    p.on('close', () => {
      clearTimeout(timer)
      try {
        const env = JSON.parse(out) as { is_error?: boolean; result?: string }
        resolve(env.is_error ? null : env.result ?? null)
      } catch {
        resolve(null)
      }
    })
    p.stdin.write(system ? `${system}\n\n${user}` : user)
    p.stdin.end()
  })
}

async function runOpenAI(system: string, user: string, model: string, maxTokens: number, json: boolean): Promise<string | null> {
  const key = openaiKey()
  if (!key) return null
  try {
    const res = await net.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user }
        ],
        ...(json ? { response_format: { type: 'json_object' } } : {})
      })
    })
    if (!res.ok) return null
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return body.choices?.[0]?.message?.content ?? null
  } catch {
    return null
  }
}

let _an: Anthropic | null = null
async function runAnthropic(system: string, user: string, model: string, maxTokens: number): Promise<string | null> {
  const key = anthropicKey()
  if (!key) return null
  if (!_an || _an.apiKey !== key) _an = new Anthropic({ apiKey: key })
  try {
    const msg = await _an.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
    return msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n')
  } catch {
    return null
  }
}

// ── Vision (image → text) backends ────────────────────────────────────────────────────────
// Claude Code reads the image off disk (its Read tool handles images) — key-free, so it stays the
// preferred backend. The API backends take the bytes as a base64 image part.
function runClaudeVision(prompt: string, filePath: string, model: string): Promise<string | null> {
  const bin = claudeBin()
  if (!bin) return Promise.resolve(null)
  return new Promise((resolve) => {
    let out = ''
    // --allowedTools Read so the file read never blocks on a permission prompt in headless -p mode.
    const p = spawn(bin, ['-p', '--model', model, '--output-format', 'json', '--allowedTools', 'Read'], { env: { ...process.env } })
    const timer = setTimeout(() => { p.kill(); resolve(null) }, 90_000)
    p.stdout.on('data', (d) => (out += d.toString()))
    p.on('error', () => { clearTimeout(timer); resolve(null) })
    p.on('close', () => {
      clearTimeout(timer)
      try {
        const env = JSON.parse(out) as { is_error?: boolean; result?: string }
        resolve(env.is_error ? null : env.result ?? null)
      } catch {
        resolve(null)
      }
    })
    p.stdin.write(`${prompt}\n\nRead the image at this path and answer: ${filePath}`)
    p.stdin.end()
  })
}

async function runOpenAIVision(prompt: string, dataUrl: string, model: string, maxTokens: number): Promise<string | null> {
  const key = openaiKey()
  if (!key) return null
  try {
    const res = await net.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }]
      })
    })
    if (!res.ok) return null
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return body.choices?.[0]?.message?.content ?? null
  } catch {
    return null
  }
}

async function runAnthropicVision(prompt: string, base64: string, mime: string, model: string, maxTokens: number): Promise<string | null> {
  const key = anthropicKey()
  if (!key) return null
  if (!_an || _an.apiKey !== key) _an = new Anthropic({ apiKey: key })
  try {
    const media = /png/i.test(mime) ? 'image/png' : /webp/i.test(mime) ? 'image/webp' : /gif/i.test(mime) ? 'image/gif' : 'image/jpeg'
    const msg = await _an.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: media as 'image/jpeg', data: base64 } }, { type: 'text', text: prompt }] }]
    })
    return msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n')
  } catch {
    return null
  }
}

async function complete(system: string, user: string, tier: Tier, maxTokens: number, json: boolean): Promise<{ text: string; engine: string } | null> {
  for (const backend of backendOrder()) {
    const model = MODELS[backend][tier]
    let text: string | null = null
    if (backend === 'claude-code') text = await runClaude(system, user, model)
    else if (backend === 'openai') text = await runOpenAI(system, user, model, maxTokens, json)
    else text = await runAnthropic(system, user, model, maxTokens)
    if (text && text.trim()) return { text: text.trim(), engine: `${backend}:${model}` }
  }
  return null
}

// ── Public API ──────────────────────────────────────────────────────────────────────────
export async function completeText(opts: { system?: string; user: string; tier?: Tier; maxTokens?: number }): Promise<{ text: string; engine: string } | null> {
  return complete(opts.system ?? '', opts.user, opts.tier ?? 'small', opts.maxTokens ?? 1024, false)
}

/**
 * Describe an image → text, Claude-Code-first. `filePath` feeds the key-free CLI (it reads the file);
 * `bytes`/`mime` feed the API backends as a base64 image part. Returns null if no backend can see it.
 */
export async function describeImage(opts: { prompt: string; filePath: string; bytes: ArrayBuffer; mime: string; tier?: Tier; maxTokens?: number }): Promise<{ text: string; engine: string } | null> {
  const tier = opts.tier ?? 'small'
  const maxTokens = opts.maxTokens ?? 400
  const base64 = Buffer.from(opts.bytes).toString('base64')
  const dataUrl = `data:${opts.mime || 'image/jpeg'};base64,${base64}`
  for (const backend of backendOrder()) {
    const model = MODELS[backend][tier]
    let text: string | null = null
    if (backend === 'claude-code') text = await runClaudeVision(opts.prompt, opts.filePath, model)
    else if (backend === 'openai') text = await runOpenAIVision(opts.prompt, dataUrl, model, maxTokens)
    else text = await runAnthropicVision(opts.prompt, base64, opts.mime, model, maxTokens)
    if (text && text.trim()) return { text: text.trim(), engine: `${backend}:${model}` }
  }
  return null
}

function stripFences(s: string): string {
  const m = s.trim().match(/```(?:json)?\s*([\s\S]*?)```/)
  return (m ? m[1] : s).trim()
}

/** Complete + parse a JSON object. The `user` prompt MUST instruct the model to return JSON. */
export async function completeJSON<T>(opts: { system?: string; user: string; tier?: Tier; maxTokens?: number }): Promise<{ data: T; engine: string } | null> {
  const r = await complete(opts.system ?? '', opts.user, opts.tier ?? 'small', opts.maxTokens ?? 2048, true)
  if (!r) return null
  try {
    return { data: JSON.parse(stripFences(r.text)) as T, engine: r.engine }
  } catch {
    // A model may prepend prose — grab the first {...} block.
    const m = r.text.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        return { data: JSON.parse(m[0]) as T, engine: r.engine }
      } catch {
        return null
      }
    }
    return null
  }
}
