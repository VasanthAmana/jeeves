// Loaded by `pnpm test` (node --import) so the app's own sources run under Node's type stripping:
// they import siblings without an extension ('./source') and the shared contract via the '@shared/*'
// alias, both of which the bundler resolves in the app. Type-only imports are erased and never load.
import { register } from 'node:module'

register('./resolve-ts.mjs', import.meta.url)
