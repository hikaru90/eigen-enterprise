import type { RequestHandler } from './$types'
import { liveSocial, socialJson } from '$lib/server/brand/social'
import { parseUploadForm, personActor, readJson } from '../../../../../../modules/brand/social/http'
import {
  createGraphicPostInputSchema,
  socialStatusSchema,
} from '../../../../../../modules/brand/social/types'

/**
 * GET: the company's social posts, newest first (?status=draft|ready|posted).
 * POST JSON: a branded graphic post. POST multipart: an uploaded post (its
 * files + title, networks, captions, status, planned day) in one step.
 */
export const GET: RequestHandler = ({ locals, url }) =>
  socialJson('Listing the social posts (Brand › Social)', async () => {
    personActor(locals.user)
    const raw = url.searchParams.get('status')
    const status = raw === null ? undefined : socialStatusSchema.parse(raw)
    return { posts: await liveSocial().posts.list(status === undefined ? {} : { status }) }
  })

export const POST: RequestHandler = ({ locals, request }) =>
  socialJson('Creating a social post (Brand › Social)', async () => {
    const actor = personActor(locals.user)
    const social = liveSocial()
    if ((request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
      const { fields, files } = await parseUploadForm(await request.formData())
      return social.media().uploadPost(actor, fields, files)
    }
    return social.posts.createGraphic(
      createGraphicPostInputSchema.parse(await readJson(request)),
      actor,
    )
  })
