// Resolve hook (see register.mjs): '@shared/x' → src/shared/x.ts, and an extensionless relative
// import → the .ts file next to it.
import { existsSync } from 'node:fs'
import { URL, fileURLToPath, pathToFileURL } from 'node:url'

const SHARED = new URL('../../src/shared/', import.meta.url)

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@shared/')) return next(new URL(specifier.slice(8) + '.ts', SHARED).href, context)
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
    const url = new URL(specifier + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(url))) return next(pathToFileURL(fileURLToPath(url)).href, context)
  }
  return next(specifier, context)
}
