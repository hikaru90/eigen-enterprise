import type { UploadFile } from './media'
import { error, json } from '@sveltejs/kit'
import { z } from 'zod'
import { SocialPostError, uploadPostFieldsSchema, type SocialActor, type UploadPostFields } from './types'

/**
 * The Brand › Social tab's seam onto the library: every signed-in member works
 * on the company's posts (like Material, the posts are company material, not
 * guidelines). SocialPostError → its HTTP status with a plain sentence; a
 * schema failure → 400 naming the field; anything else is a real failure.
 */

const STATUS: Record<SocialPostError['code'], number> = { not_found: 404, invalid: 400, unavailable: 503, upstream: 502 }

export function personActor(user: { id: string } | null | undefined): SocialActor & { kind: 'user' } {
  if (!user) error(401, 'Sign in first.')
  return { kind: 'user', userId: user.id }
}

export async function socialJson(run: () => Promise<unknown>): Promise<Response> {
  try {
    const out = await run()
    return out === undefined ? new Response(null, { status: 204 }) : json(out)
  } catch (err) {
    if (err instanceof SocialPostError) return json({ message: err.message }, { status: STATUS[err.code] })
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      const field = issue?.path.join('.')
      return json({ message: field ? `${field}: ${issue.message}` : (issue?.message ?? 'Invalid input') }, { status: 400 })
    }
    throw err
  }
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new SocialPostError('invalid', 'The request body is not JSON.')
  }
}

/** The upload form: title, networks[], status, plannedFor, caption_<network>, and the files. */
export async function parseUploadForm(form: FormData): Promise<{ fields: UploadPostFields; files: UploadFile[] }> {
  const str = (k: string) => {
    const v = form.get(k)
    return typeof v === 'string' ? v : undefined
  }
  const networks = form.getAll('networks').filter((v): v is string => typeof v === 'string')
  const captions: Record<string, string> = {}
  for (const n of networks) {
    const c = str(`caption_${n}`)?.trim()
    if (c) captions[n] = c
  }
  const planned = str('plannedFor')?.trim()
  const fields = uploadPostFieldsSchema.parse({
    title: str('title') ?? '',
    networks,
    captions,
    status: str('status') || 'draft',
    plannedFor: planned ? planned : null,
  })
  const files: UploadFile[] = []
  for (const v of form.getAll('files')) {
    if (typeof v === 'string') continue
    files.push({ name: v.name, mime: v.type, bytes: new Uint8Array(await v.arrayBuffer()) })
  }
  return { fields, files }
}
