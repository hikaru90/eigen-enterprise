import { describe, expect, it } from 'vitest'
import {
  appendJsonl,
  canonicalJson,
  canonicalMarkdown,
  canonicalYaml,
  CanonicalError,
  jsonlLine,
  parseJsonl,
  parseMarkdown,
  parseYaml,
} from './canonical'

describe('canonical formats', () => {
  const a = {
    z: 1,
    a: { y: [3, 1, 2], b: 'x' },
    d: new Date('2026-01-02T03:04:05.000Z'),
    u: undefined,
  }
  const b = { d: new Date('2026-01-02T03:04:05.000Z'), a: { b: 'x', y: [3, 1, 2] }, z: 1 }

  it('JSON: same value → same bytes regardless of key order; arrays keep order', () => {
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(canonicalJson(a)).toBe(
      '{\n  "a": {\n    "b": "x",\n    "y": [\n      3,\n      1,\n      2\n    ]\n  },\n  "d": "2026-01-02T03:04:05.000Z",\n  "z": 1\n}\n',
    )
  })

  it('YAML: byte-deterministic, sorted, round-trips (ISO dates stay strings, ambiguous strings quoted)', () => {
    const y = canonicalYaml(a)
    expect(y).toBe(canonicalYaml(b))
    expect(y).toBe(
      'a:\n  b: x\n  y:\n    - 3\n    - 1\n    - 2\nd: 2026-01-02T03:04:05.000Z\nz: 1\n',
    )
    expect(parseYaml(y)).toEqual({
      a: { b: 'x', y: [3, 1, 2] },
      d: '2026-01-02T03:04:05.000Z',
      z: 1,
    })
    const tricky = { s: ['01', 'true', 'null', '1.5', 'a: b', '', ' lead'] }
    expect(parseYaml(canonicalYaml(tricky))).toEqual(tricky)
    expect(canonicalYaml(parseYaml(canonicalYaml(tricky)))).toBe(canonicalYaml(tricky))
  })

  it('refuses non-serializable values loudly', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalError)
    expect(() => canonicalJson([undefined])).toThrow(CanonicalError)
    expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalError)
  })

  it('Markdown with frontmatter: canonical bytes + round trip, CRLF normalized', () => {
    const md = canonicalMarkdown({
      frontmatter: { title: 'T', id: 'n1' },
      body: '\r\n# Hi\r\n\r\ntext  \r\n\r\n',
    })
    expect(md).toBe('---\nid: n1\ntitle: T\n---\n\n# Hi\n\ntext\n')
    expect(parseMarkdown(md)).toEqual({
      frontmatter: { id: 'n1', title: 'T' },
      body: '# Hi\n\ntext',
    })
    expect(canonicalMarkdown(parseMarkdown(md))).toBe(md)
    expect(canonicalMarkdown({ frontmatter: {}, body: 'x' })).toBe('x\n')
  })

  it('JSONL: one compact sorted record per line, append-only', () => {
    expect(jsonlLine({ b: 1, a: 'x' })).toBe('{"a":"x","b":1}\n')
    const one = appendJsonl('', [{ id: 1 }])
    const two = appendJsonl(one, [{ id: 2 }])
    expect(two.startsWith(one)).toBe(true)
    expect(parseJsonl(two)).toEqual([{ id: 1 }, { id: 2 }])
    expect(() => appendJsonl('{"a":1}', [{}])).toThrow(CanonicalError)
  })
})
