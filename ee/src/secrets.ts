import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * ee's secret store (D9): one AES-256-GCM encrypted JSON document,
 * { [workload]: { [NAME]: value } }, under a host key generated at install.
 * Values are write-only from the outside: the API returns names, never values.
 */

export type SecretMap = Record<string, Record<string, string>>

const VERSION = 'ee-secrets-v1'

export function encryptSecrets(key: Buffer, data: SecretMap): string {
  if (key.length !== 32) throw new Error('secret store key must be 32 bytes')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join('.')
}

export function decryptSecrets(key: Buffer, blob: string): SecretMap {
  const [version, iv, tag, body] = blob.trim().split('.')
  if (version !== VERSION || !iv || !tag || !body) {
    throw new Error('secret store is not an ee-secrets-v1 document')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  let plain: string
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
  } catch (err) {
    throw new Error('secret store failed to decrypt (wrong host key or tampered file)', { cause: err })
  }
  return JSON.parse(plain) as SecretMap
}

/** Render a systemd EnvironmentFile. Values are double-quoted (systemd honours \\ and \" escapes there). */
export function renderEnvFile(values: Record<string, string>): string {
  return (
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => {
        if (/[\n\r]/.test(v)) throw new Error(`secret ${k} contains a newline; not representable in an EnvironmentFile`)
        return `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      })
      .join('\n') + '\n'
  )
}

/** A strong random value for generated system secrets. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
