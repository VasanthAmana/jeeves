import { safeStorage } from 'electron'
import { getDb } from '../db'

// OS-keychain-backed secret store. Values are encrypted with Electron safeStorage
// (which derives its key from the OS keychain) and persisted as blobs in the
// `secrets` table. Nothing plaintext ever touches disk. A caller references a secret
// by NAME (see ./names.ts) — the raw value never leaves the main process.

export function isSecretStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function setSecret(name: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secret storage is unavailable — refusing to store a secret in plaintext')
  }
  const blob = safeStorage.encryptString(value)
  getDb()
    .prepare(
      `INSERT INTO secrets (name, blob, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`
    )
    .run(name, blob, Date.now())
}

export function getSecret(name: string): string | null {
  const row = getDb().prepare('SELECT blob FROM secrets WHERE name = ?').get(name) as
    | { blob: Buffer }
    | undefined
  if (!row) return null
  return safeStorage.decryptString(row.blob)
}

export function deleteSecret(name: string): void {
  getDb().prepare('DELETE FROM secrets WHERE name = ?').run(name)
}
