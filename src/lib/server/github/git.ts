import { createHash } from 'node:crypto'

/** Git's object id for a blob: sha1("blob " + byte length + NUL + bytes). */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`, 'utf8').update(bytes).digest('hex')
}

/** Fails before a caller can persist bytes that do not match GitHub's tree entry. */
export function verifyGitBlobSha(bytes: Uint8Array, expectedSha: string): void {
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error(`Git blob sha must be 40 lowercase hexadecimal characters, got ${JSON.stringify(expectedSha)}`)
  }
  const actualSha = gitBlobSha(bytes)
  if (actualSha !== expectedSha) {
    throw new Error(`Git blob sha mismatch: expected ${expectedSha}, computed ${actualSha}`)
  }
}
