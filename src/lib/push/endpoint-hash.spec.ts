import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { endpointHash } from './endpoint-hash'

describe('endpointHash', () => {
  it('is the SHA-256 of the endpoint, hex — the same in the browser and on the server', async () => {
    const endpoint = 'https://web.push.apple.com/QGx2dk-abc'
    expect(await endpointHash(endpoint)).toBe(createHash('sha256').update(endpoint).digest('hex'))
  })

  it('differs per endpoint (one per device)', async () => {
    expect(await endpointHash('https://a')).not.toBe(await endpointHash('https://b'))
  })
})
