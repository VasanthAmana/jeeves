import { getDb } from './index'

// Non-secret app-level key/value settings (the demo toggle, the inclusion allow-list, the
// extraction recipe + selector heals). Secrets — like an OpenAI/Anthropic API key — do NOT
// belong here; they live safeStorage-encrypted in the `secrets` table via ../secrets/keychain.ts.

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, Date.now())
}
