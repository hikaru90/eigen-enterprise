import { createHmac, timingSafeEqual } from 'node:crypto'

/** X-Hub-Signature-256 check (HMAC-SHA256 over the raw body, constant-time compare). */
export function verifyGitHubSignature(secret: string, body: string, header: string | null): boolean {
  if (!header?.startsWith('sha256=')) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`)
  const actual = Buffer.from(header)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export type PushEvent = { ref: string; after: string; deleted?: boolean; repository: { full_name: string } }

/** A push to a branch (not a tag, not a deletion) → { repo, ref, after }; anything else → null. */
export function pushTarget(e: PushEvent): { repo: string; ref: string; after: string } | null {
  if (e.deleted || !e.ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(e.after)) return null
  return { repo: e.repository.full_name, ref: e.ref.slice('refs/heads/'.length), after: e.after }
}
