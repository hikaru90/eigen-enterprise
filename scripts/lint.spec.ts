import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromShared, toShared } from './lint.mjs'

const a = path.join(path.sep, 'repo', 'main')
const b = path.join(path.sep, 'repo', '.claude', 'worktrees', 'x')

function entry(abs: string, messages: unknown[] = []) {
  return { hash: 'h1', hashOfConfig: 'c1', results: { filePath: abs, messages, errorCount: 0 } }
}

describe('shared lint cache path mapping', () => {
  it('round-trips an entry from one checkout into another checkout', () => {
    const shared = toShared(
      { [path.join(a, 'src', 'x.ts')]: entry(path.join(a, 'src', 'x.ts')) },
      a,
    )
    expect(Object.keys(shared)).toEqual([path.join('src', 'x.ts')])
    const local = fromShared(shared, b)
    const abs = path.join(b, 'src', 'x.ts')
    expect(local).toEqual({ [abs]: entry(abs) })
  })

  it('does not share entries whose result mentions the checkout path', () => {
    const abs = path.join(a, 'src', 'y.svelte')
    const shared = toShared({ [abs]: entry(abs, [{ message: `not in project ${abs}` }]) }, a)
    expect(shared).toEqual({})
  })

  it('does not share files outside the checkout or entries without content hash', () => {
    const outside = path.join(path.sep, 'elsewhere', 'z.ts')
    const noHash = path.join(a, 'n.ts')
    expect(
      toShared({ [outside]: entry(outside), [noHash]: { results: { filePath: noHash } } }, a),
    ).toEqual({})
  })

  it('fails loud on a non-relative key in the shared cache', () => {
    expect(() => fromShared({ [path.join(a, 'x.ts')]: entry('x') }, b)).toThrow(/non-relative/)
    expect(() => fromShared({ [path.join('..', 'x.ts')]: entry('x') }, b)).toThrow(/non-relative/)
  })
})
