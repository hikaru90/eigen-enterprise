import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { Transform, type TransformCallback } from 'node:stream'

/**
 * The backup object format "EEBK v1" (README.md next to this file): every
 * object ee uploads is AES-256-GCM in authenticated chunks under a per-object
 * key derived from the company's backup key. Truncation, reordering and
 * tampering all fail authentication.
 */

export const MAGIC = Buffer.from('EEBK', 'ascii')
export const VERSION = 1
export const HEADER_LEN = 4 + 1 + 4 + 32
export const TAG_LEN = 16
export const DEFAULT_CHUNK = 1024 * 1024
const MAX_CHUNK = 16 * 1024 * 1024
const INFO = Buffer.from('ee-backup/v1/object-key', 'ascii')

export class BackupAuthError extends Error {
  constructor(detail: string) {
    super(`backup data failed authentication (${detail}): wrong recovery code, or the object was altered or truncated`)
  }
}

export function newBackupKey(): Buffer {
  return randomBytes(32)
}

function objectKey(key: Buffer, salt: Buffer): Buffer {
  if (key.length !== 32) throw new Error('backup key must be 32 bytes')
  return Buffer.from(hkdfSync('sha256', key, salt, INFO, 32))
}

function nonce(counter: number, final: boolean): Buffer {
  const n = Buffer.alloc(12)
  n.writeUInt32BE(counter, 7)
  n[11] = final ? 1 : 0
  return n
}

/** Encrypting transform: plaintext in, EEBK v1 bytes out. */
export function encryptStream(key: Buffer, chunkSize = DEFAULT_CHUNK): Transform {
  if (chunkSize < 16 || chunkSize > MAX_CHUNK) throw new Error(`chunk size ${chunkSize} out of range`)
  const salt = randomBytes(32)
  const header = Buffer.alloc(HEADER_LEN)
  MAGIC.copy(header, 0)
  header[4] = VERSION
  header.writeUInt32BE(chunkSize, 5)
  salt.copy(header, 9)
  const k = objectKey(key, salt)
  let counter = 0
  let pending: Buffer[] = []
  let pendingLen = 0
  const seal = (plain: Buffer, final: boolean): Buffer => {
    if (counter > 0xffffffff) throw new Error('object too large for EEBK v1')
    const c = createCipheriv('aes-256-gcm', k, nonce(counter++, final))
    c.setAAD(header)
    const body = Buffer.concat([c.update(plain), c.final()])
    return Buffer.concat([body, c.getAuthTag()])
  }
  let headerSent = false
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        if (!headerSent) {
          this.push(header)
          headerSent = true
        }
        pending.push(chunk)
        pendingLen += chunk.length
        // Strictly more than one chunk buffered: the last chunk is always held
        // back so it can be sealed as final.
        if (pendingLen > chunkSize) {
          let all = Buffer.concat(pending)
          while (all.length > chunkSize) {
            this.push(seal(all.subarray(0, chunkSize), false))
            all = all.subarray(chunkSize)
          }
          pending = [all]
          pendingLen = all.length
        }
        cb()
      } catch (err) {
        cb(err as Error)
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!headerSent) this.push(header)
        this.push(seal(Buffer.concat(pending), true))
        cb()
      } catch (err) {
        cb(err as Error)
      }
    },
  })
}

/** Decrypting transform: EEBK v1 bytes in, plaintext out; errors on any tamper/truncation. */
export function decryptStream(key: Buffer): Transform {
  let header: Buffer | null = null
  let k: Buffer | null = null
  let record = 0
  let counter = 0
  let buf: Buffer = Buffer.alloc(0)
  const open = (rec: Buffer, final: boolean): Buffer => {
    if (rec.length < TAG_LEN) throw new BackupAuthError('truncated chunk')
    const d = createDecipheriv('aes-256-gcm', k!, nonce(counter++, final))
    d.setAAD(header!)
    d.setAuthTag(rec.subarray(rec.length - TAG_LEN))
    try {
      return Buffer.concat([d.update(rec.subarray(0, rec.length - TAG_LEN)), d.final()])
    } catch {
      throw new BackupAuthError(`chunk ${counter - 1}`)
    }
  }
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
        if (!header) {
          if (buf.length < HEADER_LEN) return cb()
          header = Buffer.from(buf.subarray(0, HEADER_LEN))
          if (!header.subarray(0, 4).equals(MAGIC)) throw new Error('not an ee backup object (bad magic)')
          if (header[4] !== VERSION) throw new Error(`unsupported ee backup format version ${header[4]}`)
          const chunkSize = header.readUInt32BE(5)
          if (chunkSize < 16 || chunkSize > MAX_CHUNK) throw new Error(`bad chunk size ${chunkSize}`)
          record = chunkSize + TAG_LEN
          k = objectKey(key, header.subarray(9, 41))
          buf = buf.subarray(HEADER_LEN)
        }
        while (buf.length > record) {
          this.push(open(buf.subarray(0, record), false))
          buf = buf.subarray(record)
        }
        cb()
      } catch (err) {
        cb(err as Error)
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!header) throw new BackupAuthError('missing header')
        this.push(open(buf, true))
        cb()
      } catch (err) {
        cb(err as Error)
      }
    },
  })
}

// --- Recovery code: the backup key written for humans -----------------------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32

function base32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function unbase32(s: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) throw new Error(`recovery code has an invalid character "${ch}"`)
    value = (value << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

const checksum = (key: Buffer) => base32(createHash('sha256').update('ee-recovery').update(key).digest().subarray(0, 2)).slice(0, 2)

/** 32-byte key → 52 base32 chars + 2 checksum chars, in groups of 6 ("ABCDEF-GHJKMN-…"). */
export function recoveryCode(key: Buffer): string {
  if (key.length !== 32) throw new Error('backup key must be 32 bytes')
  const s = base32(key) + checksum(key)
  return s.match(/.{1,6}/g)!.join('-')
}

/** Parse what a human typed back (case, dashes, spaces, O/I/L look-alikes forgiven). */
export function parseRecoveryCode(input: string): Buffer {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (s.length !== 54) throw new Error(`a recovery code has 54 characters (got ${s.length})`)
  const key = unbase32(s.slice(0, 52)).subarray(0, 32)
  if (checksum(key) !== s.slice(52)) throw new Error('recovery code checksum does not match — a character is mistyped')
  return key
}
