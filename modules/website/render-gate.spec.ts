import { describe, expect, it } from 'vitest'
import { isPubliclyRenderable } from './render-gate'

describe('isPubliclyRenderable (the /s/[slug] render gate)', () => {
  it('is true only for visibility public', () => {
    expect(isPubliclyRenderable({ visibility: 'public' })).toBe(true)
  })

  it('is false for private content, unknown slugs, and missing pages', () => {
    expect(isPubliclyRenderable({ visibility: 'private' })).toBe(false)
    expect(isPubliclyRenderable(null)).toBe(false)
    expect(isPubliclyRenderable(undefined)).toBe(false)
  })
})
