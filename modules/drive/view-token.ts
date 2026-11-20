/**
 * Short-lived capability for a rendered HTML page (/drive-view/<token>/…).
 * The page runs in a sandboxed frame with an opaque origin, so its requests
 * for its own styles, scripts and images can't rely on the session cookie;
 * the token in the path says who is reading and below which folder. Every
 * request still goes through Drive's access check as that person.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

/** One hour: a page opened for longer is reopened from the Drive. */
export const VIEW_TOKEN_TTL_MS = 60 * 60 * 1000

export type ViewScope = {
  userId: string
  /** The folder whose files the page may load; null for a top-level file (only itself). */
  folderId: string | null
  /** The HTML file the page was opened for, and its name (the path that serves it, even without access to its folder). */
  fileId: string
  fileName: string
}

const payload = z.object({ u: z.string().min(1), f: z.string().min(1).nullable(), p: z.string().min(1), n: z.string().min(1), e: z.number().int() }).strict()

const sign = (secret: Buffer, body: string) => createHmac('sha256', secret).update(`drive-view.v1.${body}`).digest('base64url')

export function mintViewToken(secret: Buffer, scope: ViewScope, now: number): string {
  const body = Buffer.from(JSON.stringify({ u: scope.userId, f: scope.folderId, p: scope.fileId, n: scope.fileName, e: now + VIEW_TOKEN_TTL_MS })).toString('base64url')
  return `${body}.${sign(secret, body)}`
}

/** The token's scope, or null when it is malformed, forged or expired. */
export function readViewToken(secret: Buffer, token: string, now: number): (ViewScope & { expiresAt: number }) | null {
  const [body, sig, ...rest] = token.split('.')
  if (!body || !sig || rest.length > 0) return null
  const want = Buffer.from(sign(secret, body))
  const got = Buffer.from(sig)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const p = payload.safeParse(raw)
  if (!p.success || p.data.e < now) return null
  return { userId: p.data.u, folderId: p.data.f, fileId: p.data.p, fileName: p.data.n, expiresAt: p.data.e }
}
