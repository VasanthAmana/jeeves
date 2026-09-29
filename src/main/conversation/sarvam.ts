import { getSecret } from '../secrets/keychain'
import { SARVAM_KEY_SECRET } from '../secrets/names'

// Sarvam AI STT (Saarika) — specialised for Indian languages + code-mixed (Tanglish/Hinglish)
// speech, used for WhatsApp voice notes. Used windowed: the renderer captures the decrypted
// audio and ships the bytes over IPC; MAIN posts them to Sarvam with the KEYCHAIN key (never
// in the renderer). This is a cloud engine — audio leaves the device for Sarvam.

const MODEL = 'saarika:v2.5'
// 'unknown' = auto-detect language; override via env to ta-IN / hi-IN / en-IN.
const LANGUAGE = process.env.PA_SARVAM_LANGUAGE ?? 'unknown'

export interface Segment {
  t_start: number
  t_end: number
  text: string
  speaker?: string
}

export function sarvamAvailable(): boolean {
  try {
    return !!getSecret(SARVAM_KEY_SECRET)
  } catch {
    return false
  }
}

// Batch REST returns one transcript per request (no per-word timestamps), so each window
// becomes a single segment.
export async function sarvamTranscribe(
  audio: ArrayBuffer,
  filename: string
): Promise<{ language: string; segments: Segment[]; text: string }> {
  const key = getSecret(SARVAM_KEY_SECRET)
  if (!key) throw new Error('Sarvam key not set')
  const fd = new FormData()
  fd.append('file', new Blob([audio]), filename || 'voice.ogg')
  fd.append('model', MODEL)
  fd.append('language_code', LANGUAGE)
  const res = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': key },
    body: fd
  })
  if (!res.ok) throw new Error(`Sarvam ${res.status}`)
  const j = (await res.json()) as { transcript?: string; language_code?: string }
  const text = (j.transcript || '').trim()
  return { language: j.language_code || '', segments: text ? [{ t_start: 0, t_end: 0, text }] : [], text }
}
