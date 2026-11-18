import { join } from 'node:path'
import { liveCaptionChat, suggestCaptions } from '../../../../modules/brand/social/captions'
import { createSocialMediaService, type SocialBlobStore } from '../../../../modules/brand/social/media'
import { defaultSocialPostStore } from '../../../../modules/brand/social/store'
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

export function socialMediaBlobs(env: Record<string, string | undefined> = process.env): SocialBlobStore {
  live ??= diskBlobStore(resolveSocialMediaDir(env))
  return live
}

export function liveSocial() {
  const posts = defaultSocialPostStore()
  return {
    posts,
    /** The file side resolves its storage only when a route touches files (fails loud without storage). */
    media: () => createSocialMediaService({ posts, blobs: socialMediaBlobs(), maxUploadBytes: resolveMaxUploadBytes(process.env) }),
    suggest: (input: Parameters<typeof suggestCaptions>[1]) => suggestCaptions({ posts, brand: defaultBrandStore(), chat: liveCaptionChat }, input),
  }
}
