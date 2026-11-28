import type { SocialPostStore } from './store'
import {
  SOCIAL_DOCUMENT_TYPES,
  SOCIAL_IMAGE_TYPES,
  SOCIAL_MAX_IMAGES,
  SOCIAL_VIDEO_TYPES,
  SocialPostError,
  type SocialActor,
  type SocialMedia,
  type SocialPost,
  type UploadPostFields,
} from './types'

/**
 * Uploaded social posts (Brand › Social): the files' bytes go to a
 * content-addressed blob store (wired in $lib/server/brand/social: on disk next
 * to the Drive, like the company logo), the post and its media rows to Postgres. A post is images (one, or a carousel
 * of up to SOCIAL_MAX_IMAGES), exactly one video, or exactly one PDF (a
 * LinkedIn document carousel, its pages the slides). The type is the browser's
 * declared MIME type, checked against the allowed formats; anything else is
 * refused loud.
 */

export type UploadFile = { name: string; mime: string; bytes: Uint8Array }

/** Content-addressed bytes (the app wires the disk store next to the Drive; tests use memory). */
export type SocialBlobStore = {
  put(bytes: Uint8Array): Promise<{ sha256: string; size: number }>
  get(sha256: string): Promise<Uint8Array>
  remove(sha256: string): Promise<void>
}

const IMAGES: readonly string[] = SOCIAL_IMAGE_TYPES
const VIDEOS: readonly string[] = SOCIAL_VIDEO_TYPES
const DOCUMENTS: readonly string[] = SOCIAL_DOCUMENT_TYPES
/** Every PDF starts with these bytes; a file that only claims the type is refused. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-

export function validateUploadFiles(files: readonly UploadFile[], maxBytes: number): void {
  if (files.length === 0) throw new SocialPostError('invalid', 'Add at least one image or a video.')
  for (const f of files) {
    if (!f.name.trim()) throw new SocialPostError('invalid', 'Every file needs a name.')
    if (!IMAGES.includes(f.mime) && !VIDEOS.includes(f.mime) && !DOCUMENTS.includes(f.mime)) {
      throw new SocialPostError('invalid', `“${f.name}” isn’t a supported image (PNG, JPEG, WebP, GIF), video (MP4, MOV, WebM) or PDF.`)
    }
    if (f.bytes.byteLength === 0) throw new SocialPostError('invalid', `“${f.name}” is empty.`)
    if (DOCUMENTS.includes(f.mime) && !PDF_MAGIC.every((b, i) => f.bytes[i] === b)) {
      throw new SocialPostError('invalid', `“${f.name}” isn’t a PDF.`)
    }
    if (f.bytes.byteLength > maxBytes) {
      throw new SocialPostError('invalid', `“${f.name}” is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`)
    }
  }
  const documents = files.filter((f) => DOCUMENTS.includes(f.mime)).length
  if (documents > 0 && files.length > 1) throw new SocialPostError('invalid', 'A PDF post has exactly one PDF and no other files.')
  const videos = files.filter((f) => VIDEOS.includes(f.mime)).length
  if (videos > 0 && files.length > 1) throw new SocialPostError('invalid', 'A video post has exactly one video and no images.')
  if (files.length > SOCIAL_MAX_IMAGES) throw new SocialPostError('invalid', `A carousel has at most ${SOCIAL_MAX_IMAGES} images.`)
}

export type SocialMediaService = {
  uploadPost(actor: SocialActor, fields: UploadPostFields, files: readonly UploadFile[]): Promise<SocialPost>
  deletePost(postId: string): Promise<void>
  readMedia(mediaId: string): Promise<{ media: SocialMedia; bytes: Uint8Array }>
}

export function createSocialMediaService(deps: { posts: SocialPostStore; blobs: SocialBlobStore; maxUploadBytes: number }): SocialMediaService {
  return {
    async uploadPost(actor, fields, files) {
      validateUploadFiles(files, deps.maxUploadBytes)
      const stored = []
      for (const f of files) {
        const { sha256, size } = await deps.blobs.put(f.bytes)
        stored.push({ name: f.name.trim().slice(0, 255), mime: f.mime, size, sha256 })
      }
      return deps.posts.createUpload(fields, stored, actor)
    },
    async deletePost(postId) {
      const media = await deps.posts.remove(postId)
      for (const sha of new Set(media.map((m) => m.sha256))) {
        if (!(await deps.posts.blobInUse(sha))) await deps.blobs.remove(sha)
      }
    },
    async readMedia(mediaId) {
      const media = await deps.posts.getMedia(mediaId)
      if (!media) throw new SocialPostError('not_found', `No social media file ${mediaId}.`)
      return { media, bytes: await deps.blobs.get(media.sha256) }
    },
  }
}
