import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildStyles, parseAuthoredPalettes, serializeStyles } from './build'

/**
 * Regenerates modules/brand/taxonomy/styles.json from authoring/palettes.json
 * (brand picker B2a). Runs through vitest on purpose, like the corpus build:
 *
 *   npx vitest run modules/brand/taxonomy/authoring/build-styles.spec.ts
 *
 * The output is deterministic; a content-stable rebuild leaves the file
 * untouched. The gates over the written file live in ../styles.spec.ts.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const taxonomyDir = path.join(here, '..')
const corpusDir = path.join(taxonomyDir, '..', 'corpus')
const stylesPath = path.join(taxonomyDir, 'styles.json')

describe('styles.json build (brand picker B2a)', () => {
  const authored = parseAuthoredPalettes(JSON.parse(readFileSync(path.join(here, 'palettes.json'), 'utf8')))

  it('builds deterministically and writes styles.json when content changed', () => {
    const first = serializeStyles(buildStyles(authored, corpusDir).index)
    const second = serializeStyles(buildStyles(authored, corpusDir).index)
    expect(second).toBe(first)
    if (!existsSync(stylesPath) || readFileSync(stylesPath, 'utf8') !== first) writeFileSync(stylesPath, first)
    expect(readFileSync(stylesPath, 'utf8')).toBe(first)
  })

  it('rejects a palette given both as corpus and authored for the same theme', () => {
    const bad = structuredClone(authored)
    const v = bad.genres[0]!.styles[0]!.variants[0]!
    v.corpus = { light: 'archetype-swiss-grid' }
    v.light = { bg: '#fff', fg: '#000', primary: '#f00', accent: '#00f' }
    expect(() => buildStyles(bad, corpusDir)).toThrow(/both as corpus and authored/)
  })
})
