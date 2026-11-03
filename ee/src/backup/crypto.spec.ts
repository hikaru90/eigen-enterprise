import { randomBytes } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import { BackupAuthError, decryptStream, encryptStream, HEADER_LEN, newBackupKey, parseRecoveryCode, recoveryCode, TAG_LEN } from './crypto.ts'

async function run(input: Buffer, t: NodeJS.ReadWriteStream, pieces = 7): Promise<Buffer> {
  const out: Buffer[] = []
  const src = Readable.from((function* () {
    const step = Math.max(1, Math.ceil(input.length / pieces))
    for (let i = 0; i < input.length; i += step) yield input.subarray(i, i + step)
  })())
  await pipeline(src, t, new Writable({ write(c: Buffer, _e, cb) { out.push(c); cb() } }))
  return Buffer.concat(out)
}

describe('EEBK v1 stream encryption', () => {
  const key = newBackupKey()

  for (const size of [0, 1, 63, 64, 65, 128, 1000]) {
    it(`round-trips ${size} bytes across chunk boundaries`, async () => {
      const plain = randomBytes(size)
      const enc = await run(plain, encryptStream(key, 64))
      const chunks = Math.max(1, Math.ceil(size / 64))
      expect(enc.length).toBe(HEADER_LEN + size + chunks * TAG_LEN)
      expect(enc.subarray(0, 4).toString()).toBe('EEBK')
      expect(enc[4]).toBe(1)
      expect(await run(enc, decryptStream(key), 3)).toEqual(plain)
    })
  }

  it('two encryptions of the same bytes differ (per-object salt)', async () => {
    const p = Buffer.from('same')
    expect((await run(p, encryptStream(key, 64))).equals(await run(p, encryptStream(key, 64)))).toBe(false)
  })

  it('a flipped bit anywhere fails authentication', async () => {
    const enc = await run(randomBytes(300), encryptStream(key, 64))
    for (const at of [10, HEADER_LEN + 3, HEADER_LEN + 64 + TAG_LEN + 1, enc.length - 1]) {
      const bad = Buffer.from(enc)
      bad[at]! ^= 1
      await expect(run(bad, decryptStream(key))).rejects.toThrow()
    }
  })

  it('truncation at a chunk boundary is detected (final-chunk flag)', async () => {
    const enc = await run(randomBytes(200), encryptStream(key, 64))
    const cut = enc.subarray(0, HEADER_LEN + 2 * (64 + TAG_LEN))
    await expect(run(cut, decryptStream(key))).rejects.toBeInstanceOf(BackupAuthError)
  })

  it('dropping or reordering chunks is detected', async () => {
    const enc = await run(randomBytes(64 * 3 + 5), encryptStream(key, 64))
    const rec = 64 + TAG_LEN
    const h = enc.subarray(0, HEADER_LEN)
    const c = [0, 1, 2, 3].map((i) => enc.subarray(HEADER_LEN + i * rec, HEADER_LEN + (i + 1) * rec))
    await expect(run(Buffer.concat([h, c[1]!, c[0]!, c[2]!, c[3]!]), decryptStream(key))).rejects.toBeInstanceOf(BackupAuthError)
    await expect(run(Buffer.concat([h, c[0]!, c[2]!, c[3]!]), decryptStream(key))).rejects.toBeInstanceOf(BackupAuthError)
  })

  it('the wrong key fails', async () => {
    const enc = await run(Buffer.from('secret'), encryptStream(key, 64))
    await expect(run(enc, decryptStream(newBackupKey()))).rejects.toBeInstanceOf(BackupAuthError)
  })
})

describe('recovery code', () => {
  it('encodes the key for humans and parses it back, forgiving case, dashes, spaces and look-alikes', () => {
    const key = newBackupKey()
    const code = recoveryCode(key)
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{6}-){8}[0-9A-HJKMNP-TV-Z]{6}$/)
    expect(parseRecoveryCode(code).equals(key)).toBe(true)
    const sloppy = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
    expect(parseRecoveryCode(sloppy).equals(key)).toBe(true)
  })

  it('a mistyped character is caught by the checksum', () => {
    const code = recoveryCode(Buffer.alloc(32, 7)) // fixed: a random key could collide the 10-bit checksum
    const i = 3
    const typo = code.slice(0, i) + (code[i] === 'A' ? 'B' : 'A') + code.slice(i + 1)
    expect(() => parseRecoveryCode(typo)).toThrow(/checksum|invalid/)
    expect(() => parseRecoveryCode(code.slice(0, 20))).toThrow(/54 characters/)
  })
})
