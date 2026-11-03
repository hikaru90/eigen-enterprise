import type { AccessLevel, GrantSubject } from './access-port'
import { error, json, type RequestEvent } from '@sveltejs/kit'
import { z } from 'zod'
import { DriveError, type Actor, type ItemType } from './service'

/**
 * The Drive HTTP seam: who is asking (signed-in person only — fail closed),
 * and DriveError → status. Pages and /api/drive/* routes share it.
 */

export const DRIVE_STATUS: Record<DriveError['code'], number> = { not_found: 404, forbidden: 403, invalid: 400, too_large: 413 }

export function requestActor(event: Pick<RequestEvent, 'locals'>): Actor {
  const user = event.locals.user
  if (!user) error(401, 'Sign in to use Drive.')
  return { kind: 'user', userId: user.id }
}

/** Runs a JSON API handler: DriveError becomes { error } with its status; anything else is a real failure (500). */
export async function driveJson(run: () => Promise<unknown>): Promise<Response> {
  try {
    return json((await run()) ?? { ok: true })
  } catch (err) {
    if (err instanceof DriveError) return json({ error: err.message, code: err.code }, { status: DRIVE_STATUS[err.code] })
    throw err
  }
}

/** For page loads: DriveError becomes the matching SvelteKit error page. */
export async function drivePage<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof DriveError) error(DRIVE_STATUS[err.code], err.message)
    throw err
  }
}

export function itemType(raw: string): ItemType {
  if (raw === 'folder' || raw === 'file') return raw
  throw new DriveError('not_found', 'No such item.')
}

const level = z.enum(['view', 'edit', 'manage'])
const subject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('group'), groupId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('company') }).strict(),
])
export const grantsBody = z.object({ grants: z.array(z.object({ subject, level }).strict()) }).strict()
export type GrantEntry = { subject: GrantSubject; level: AccessLevel }

export async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new DriveError('invalid', 'The request body is not JSON.')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new DriveError('invalid', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return parsed.data
}
