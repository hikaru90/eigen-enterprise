import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OS_EMBEDDING_COMPRESS_INTENSITY } from './embedding-compress.ts'

/**
 * The os app refuses to embed without EMBEDDING_COMPRESS_INTENSITY (src/lib/server/llm/embedding.ts).
 * ee never wrote it, so on every ee install indexing failed for every thought (production, 2026-11-17).
 */
describe('os embedding compress intensity', () => {
  it('is a value the app accepts', () => {
    expect(['lite', 'full', 'ultra']).toContain(OS_EMBEDDING_COMPRESS_INTENSITY)
  })

  it('is the value the example env documents', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
    expect(example).toContain(`EMBEDDING_COMPRESS_INTENSITY="${OS_EMBEDDING_COMPRESS_INTENSITY}"`)
  })

  it('is written into the os workload env by bootstrap', () => {
    const bootstrap = readFileSync(new URL('./bootstrap.ts', import.meta.url), 'utf8')
    expect(bootstrap).toMatch(/EMBEDDING_COMPRESS_INTENSITY: OS_EMBEDDING_COMPRESS_INTENSITY/)
  })
})
