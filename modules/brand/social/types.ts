import { z } from 'zod'

/**
 * Brand › Social (Contribute 6ff283ef): a library of social media posts in the
 * company's style. A post is either a branded graphic — drawn live from the
 * active visual set at a social aspect ratio, the copy kept as data — or media
 * the person uploaded (images for a single post or a carousel, or one video).
 * Each post carries one caption per target network, a status and an optional
 * planned day. Nothing is posted to the networks from here (not connected yet).
 */

export const SOCIAL_NETWORKS = ['instagram', 'linkedin', 'facebook', 'x', 'tiktok'] as const
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number]

export const SOCIAL_NETWORK_LABELS: Record<SocialNetwork, string> = {
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  x: 'X',
  tiktok: 'TikTok',
}

export const SOCIAL_STATUSES = ['draft', 'ready', 'posted'] as const
export type SocialPostStatus = (typeof SOCIAL_STATUSES)[number]

export const SOCIAL_STATUS_LABELS: Record<SocialPostStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  posted: 'Posted',
}

/** The social aspect ratios a branded graphic is drawn at (pixels of the exported PNG). */
export const SOCIAL_FORMATS = [
  { id: 'square', label: 'Square', ratio: '1:1', width: 1080, height: 1080 },
  { id: 'portrait', label: 'Portrait', ratio: '4:5', width: 1080, height: 1350 },
  { id: 'story', label: 'Story / Reel', ratio: '9:16', width: 1080, height: 1920 },
  { id: 'landscape', label: 'Link / landscape', ratio: '1.91:1', width: 1200, height: 628 },
] as const
export type SocialFormatId = (typeof SOCIAL_FORMATS)[number]['id']
export type SocialFormat = (typeof SOCIAL_FORMATS)[number]

export function socialFormat(id: SocialFormatId): SocialFormat {
  const format = SOCIAL_FORMATS.find((f) => f.id === id)
  if (!format) throw new Error(`unknown social format: ${id}`)
  return format
}

const formatIds = SOCIAL_FORMATS.map((f) => f.id) as [SocialFormatId, ...SocialFormatId[]]

/** Upload limits: images for a post or a carousel (Instagram/LinkedIn allow up to 10), or exactly one video. */
export const SOCIAL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const SOCIAL_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const
export const SOCIAL_MAX_IMAGES = 10

export const CAPTION_MAX = 3000
export const TITLE_MAX = 120

/** The networks' own caption limits (characters), capped at what a post stores. */
export const NETWORK_CAPTION_LIMITS: Record<SocialNetwork, number> = {
  instagram: 2200,
  linkedin: CAPTION_MAX,
  facebook: CAPTION_MAX,
  x: 280,
  tiktok: 2200,
}

export const socialNetworkSchema = z.enum(SOCIAL_NETWORKS)
export const socialStatusSchema = z.enum(SOCIAL_STATUSES)
export const socialFormatSchema = z.enum(formatIds)

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day as YYYY-MM-DD')

export const socialGraphicSchema = z
  .object({
    headline: z.string().trim().min(1).max(120),
    body: z.string().trim().max(400).default(''),
    cta: z.string().trim().max(40).default(''),
    mode: z.enum(['light', 'dark']).default('light'),
  })
  .strict()
export type SocialGraphic = z.infer<typeof socialGraphicSchema>

const networksSchema = z
  .array(socialNetworkSchema)
  .min(1, 'pick at least one network')
  .refine((n) => new Set(n).size === n.length, 'each network once')

/** One caption per network; only networks the post targets may carry one. */
export const socialCaptionsSchema = z.partialRecord(socialNetworkSchema, z.string().max(CAPTION_MAX))
export type SocialCaptions = z.infer<typeof socialCaptionsSchema>

function captionsMatchNetworks(v: { networks?: SocialNetwork[]; captions?: SocialCaptions }) {
  if (!v.networks || !v.captions) return true
  return Object.keys(v.captions).every((n) => v.networks!.includes(n as SocialNetwork))
}

export const createGraphicPostInputSchema = z
  .object({
    title: z.string().trim().min(1).max(TITLE_MAX),
    format: socialFormatSchema,
    graphic: socialGraphicSchema,
    networks: networksSchema,
    captions: socialCaptionsSchema.default({}),
    status: socialStatusSchema.default('draft'),
    plannedFor: day.nullable().default(null),
  })
  .strict()
  .refine(captionsMatchNetworks, { message: 'a caption for a network the post does not target', path: ['captions'] })
export type CreateGraphicPostInput = z.input<typeof createGraphicPostInputSchema>

export const uploadPostFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(TITLE_MAX),
    networks: networksSchema,
    captions: socialCaptionsSchema.default({}),
    status: socialStatusSchema.default('draft'),
    plannedFor: day.nullable().default(null),
  })
  .strict()
  .refine(captionsMatchNetworks, { message: 'a caption for a network the post does not target', path: ['captions'] })
export type UploadPostFields = z.input<typeof uploadPostFieldsSchema>

export const updatePostInputSchema = z
  .object({
    postId: z.string().uuid(),
    title: z.string().trim().min(1).max(TITLE_MAX).optional(),
    format: socialFormatSchema.optional(),
    graphic: socialGraphicSchema.optional(),
    networks: networksSchema.optional(),
    /** Replaces the whole caption map. */
    captions: socialCaptionsSchema.optional(),
    status: socialStatusSchema.optional(),
    plannedFor: day.nullable().optional(),
  })
  .strict()
export type UpdatePostInput = z.input<typeof updatePostInputSchema>

export type SocialMedia = {
  id: string
  postId: string
  position: number
  name: string
  mime: string
  size: number
  sha256: string
}

export type SocialPost = {
  id: string
  title: string
  source: 'graphic' | 'upload'
  /** Graphic posts: the aspect ratio they are drawn at. Uploads: null (the files keep their own size). */
  format: SocialFormatId | null
  graphic: SocialGraphic | null
  networks: SocialNetwork[]
  captions: SocialCaptions
  status: SocialPostStatus
  plannedFor: string | null
  media: SocialMedia[]
  createdBy: string
  createdByKind: 'user' | 'agent'
  createdAt: string
  updatedAt: string
}

export type SocialActor = { kind: 'user'; userId: string } | { kind: 'agent'; id: string }

export class SocialPostError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'unavailable' | 'upstream',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'SocialPostError'
  }
}
