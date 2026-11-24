import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The U2 contract files are imported by ee and by modules' vendored SDK, so
 * they may import only `zod` and `node:*` (plan/phase-upgrades-u2.md §9.0) —
 * plus `js-yaml` for module-manifest.ts, the repo's YAML parser.
 */
const FILES: Record<string, string[]> = {
  'module-manifest.ts': ['zod', 'js-yaml'],
  'module-receipt.ts': ['zod'],
  'module-protocol.ts': ['zod'],
  'module-bundle.ts': [],
  'module-workload.ts': ['zod'],
}

describe('U2 contract files import only what ee can bundle', () => {
  it.each(Object.entries(FILES))('%s', (file, allowed) => {
    const source = readFileSync(join(import.meta.dirname, file), 'utf8')
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]!)
    expect(specifiers.filter((s) => !s.startsWith('node:') && !allowed.includes(s))).toEqual([])
  })
})
