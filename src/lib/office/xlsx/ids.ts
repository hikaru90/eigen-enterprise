/**
 * Random ids and salts that operations write into the file (a comment's id,
 * a conditional format's GUID, a password's salt). Every operation takes
 * them from here, never from `crypto` directly: a co-edited workbook
 * (./collab/replica.ts) applies the same change in every replica, which must
 * all write the same bytes, so there they come from a generator seeded with
 * the change's id. Elsewhere they are random.
 */

let seeded: (() => number) | null = null

/** A generator of 32-bit values from a text seed (splitmix32 over the seed's FNV-1a hash). */
function generator(seed: string): () => number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  let state = h >>> 0
  return () => {
    state = (state + 0x9e3779b9) | 0
    let z = state
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b)
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35)
    return (z ^ (z >>> 16)) >>> 0
  }
}

/** Runs `work` (synchronous) with ids and salts drawn from `seed`. */
export function withSeed<T>(seed: string, work: () => T): T {
  const prev = seeded
  seeded = generator(seed)
  try {
    return work()
  } finally {
    seeded = prev
  }
}

/** `n` random bytes (seeded inside `withSeed`). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  if (!seeded) {
    globalThis.crypto.getRandomValues(out)
    return out
  }
  for (let i = 0; i < n; i += 4) {
    const v = seeded()
    for (let k = 0; k < 4 && i + k < n; k++) out[i + k] = (v >>> (k * 8)) & 0xff
  }
  return out
}

/** A version-4 GUID in Excel's spelling: "{XXXXXXXX-XXXX-4XXX-YXXX-XXXXXXXXXXXX}". */
export function newGuid(): string {
  const b = randomBytes(16)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('')
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`
}
