import type { RequestHandler } from './$types'
import { liveSocial } from '$lib/server/brand/social'
import { personActor, readJson, socialJson } from '../../../../../../../modules/brand/social/http'
import { updatePostInputSchema } from '../../../../../../../modules/brand/social/types'

/** PATCH: change a post (title, networks, captions, status, day; a graphic's format and copy). DELETE: remove it and its files. */
export const PATCH: RequestHandler = ({ locals, params, request }) =>
  socialJson(async () => {
    personActor(locals.user)
    const body = (await readJson(request)) as Record<string, unknown>
    return liveSocial().posts.update(updatePostInputSchema.parse({ ...body, postId: params.id }))
  })

export const DELETE: RequestHandler = ({ locals, params }) =>
  socialJson(async () => {
    personActor(locals.user)
    await liveSocial().media().deletePost(params.id)
  })
