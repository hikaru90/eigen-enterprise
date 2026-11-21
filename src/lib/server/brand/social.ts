import { join } from 'node:path'
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { liveCaptionChat, suggestCaptions } from '../../../../modules/brand/social/captions'
import {
  createSocialMediaService,
  type SocialBlobStore,
} from '../../../../modules/brand/social/media'
import { defaultSocialPostStore } from '../../../../modules/brand/social/store'
import { SocialPostError } from '../../../../modules/brand/social/types'
import { defaultBrandStore } from '../../../../modules/brand/store'
import { resolveMaxUploadBytes } from '../../../../modules/drive/service'
import { diskBlobStore, resolveDriveStorageDir } from '../../../../modules/drive/storage'

/**
 * The live wiring behind the Brand › Social routes: the post library on
 * Postgres, uploaded files content-addressed on disk next to the Drive
 * (<drive dir>/brand-social, like the company logo) with the Drive's upload
 * limit, and caption suggestions through the gateway on the company's AI
 * provider. The app side owns this wiring so the brand module never reaches
 * into the drive module (modules/boundaries.spec.ts).
 */

/** <drive storage dir>/brand-social — fails loud like the Drive when no storage is configured. */
export function resolveSocialMediaDir(env: Record<string, string | undefined>): string {
  return join(resolveDriveStorageDir(env), 'brand-social')
}

let live: SocialBlobStore | null = null

export function socialMediaBlobs(
  env: Record<string, string | undefined> = process.env,
): SocialBlobStore {
  live ??= diskBlobStore(resolveSocialMediaDir(env))
  return live
}

export function liveSocial() {
  const posts = defaultSocialPostStore()
  return {
    posts,
    /** The file side resolves its storage only when a route touches files (fails loud without storage). */
    media: () =>
      createSocialMediaService({
        posts,
        blobs: socialMediaBlobs(),
        maxUploadBytes: resolveMaxUploadBytes(process.env),
      }),
    suggest: (input: Parameters<typeof suggestCaptions>[1]) =>
      suggestCaptions({ posts, brand: defaultBrandStore(), chat: liveCaptionChat }, input),
  }
}

const SOCIAL_STATUS: Record<SocialPostError['code'], number> = {
  not_found: 404,
  invalid: 400,
  unavailable: 503,
  upstream: 502,
}

/**
 * The Social tab's JSON seam in the one error shape: SocialPostError → its
 * status with `{ message, error, agent }` (the tab reads `message` as before,
 * the notice reads `error` + `agent`); a schema failure → 400 naming the
 * field; anything else is a real failure (thrown).
 */
export async function socialJson(
  attempted: string,
  run: () => Promise<unknown>,
): Promise<Response> {
  try {
    const out = await run()
    return out === undefined ? new Response(null, { status: 204 }) : json(out)
  } catch (err) {
    if (err instanceof SocialPostError)
      return json(
        { message: err.message, ...errorReport(err, { attempted, plain: () => err.message }) },
        { status: SOCIAL_STATUS[err.code] },
      )
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      const field = issue?.path.join('.')
      const sentence = field ? `${field}: ${issue.message}` : (issue?.message ?? 'Invalid input')
      return json(
        {
          message: sentence,
          ...refusalReport(sentence, {
            attempted,
            cause: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          }),
        },
        { status: 400 },
      )
    }
    throw err
  }
}
