import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Minimal .env loader for DEV (no dependency). Electron main reads process.env, but electron-vite
// doesn't populate it from .env — so in dev we parse the project-root .env once at boot and set any
// keys that aren't already in the environment. Packaged builds have no .env (keys live in the
// keychain), so this simply no-ops. Only used for local convenience; never a source of shipped
// secrets. Comment lines and blanks are skipped; surrounding quotes are stripped.
export function loadDotEnv(): void {
  let raw: string
  try {
    raw = readFileSync(join(process.cwd(), '.env'), 'utf8')
  } catch {
    return // no .env — fine
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const key = m[1]
    let val = m[2]
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}
