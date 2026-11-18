import type { RequestHandler } from './$types'
import { z } from 'zod'
import { liveSocial } from '$lib/server/brand/social'
import { personActor, readJson, socialJson } from '../../../../../../../../modules/brand/social/http'
import { socialNetworkSchema } from '../../../../../../../../modules/brand/social/types'

const body = z
  .object({
    networks: z.array(socialNetworkSchema).min(1).optional(),
    locale: z.string().min(2).max(35).optional(),
    brief: z.string().trim().max(500).optional(),
  })
  .strict()

/**
 * POST { networks?, locale?, brief? }: three caption variants per network in
 * the brand voice. Saves nothing. No AI provider → 503 with a plain sentence;
 * the provider failing → 502.
 */
export const POST: RequestHandler = ({ locals, params, request }) =>
  socialJson(async () => {
    const actor = personActor(locals.user)
    const b = body.parse(await readJson(request))
    return liveSocial().suggest({ postId: params.id, userId: actor.userId, ...b })
  })
