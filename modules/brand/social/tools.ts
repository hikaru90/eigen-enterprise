import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { defaultBrandStore } from '../store'
import { liveCaptionChat, suggestCaptions, type CaptionChat, type VoiceSource } from './captions'
import { defaultSocialPostStore, type SocialPostStore } from './store'
import {
  createGraphicPostInputSchema,
  SOCIAL_FORMATS,
  SOCIAL_NETWORKS,
  socialNetworkSchema,
  SocialPostError,
  socialStatusSchema,
  updatePostInputSchema,
  type SocialActor,
  type SocialPost,
} from './types'

/**
 * Kernel tools for Brand › Social (Contribute 6ff283ef): the assistant drafts
 * branded graphic posts, edits them and asks for caption suggestions — the
 * same store and rules as the tab. Posts are internal working content (not
 * brand guidelines), so agents may write them (approvalRisk internal);
 * nothing here publishes to a network. Uploads are people's: they come with
 * files, through the tab.
 */

export type BrandSocialToolDeps = {
  posts?: SocialPostStore
  brand?: VoiceSource
  chat?: CaptionChat
}

export const SOCIAL_TAB_HREF = '/brand/social'

function actorOf(ctx: ToolContext): SocialActor {
  return ctx.principal.kind === 'human' ? { kind: 'user', userId: ctx.principal.id } : { kind: 'agent', id: ctx.principal.id }
}

/** What the tools return: the post plus where the person finds it. */
function withHref(post: SocialPost) {
  return { ...post, href: `${SOCIAL_TAB_HREF}?post=${post.id}` }
}

const listInput = z.object({ status: socialStatusSchema.optional() }).strict()
const getInput = z.object({ postId: z.string().uuid() }).strict()
const suggestInput = z
  .object({
    postId: z.string().uuid(),
    networks: z.array(socialNetworkSchema).min(1).optional(),
    locale: z.string().min(2).max(35).optional(),
    brief: z.string().trim().max(500).optional(),
  })
  .strict()

const formats = SOCIAL_FORMATS.map((f) => `${f.id} (${f.ratio})`).join(', ')

export function createBrandSocialTools(deps: BrandSocialToolDeps = {}): ToolDescriptor[] {
  const posts = () => deps.posts ?? defaultSocialPostStore()
  const brand = () => deps.brand ?? defaultBrandStore()
  const chat = deps.chat ?? liveCaptionChat
  // Any member works on the company's social posts (the /brand/social page): the brain does too, as them.
  const permission = { roles: ['admin', 'member', 'agent'] }

  return [
    {
      name: 'brand.social_post_list',
      module: 'brand',
      summary: `List the company's social media posts (Brand › Social), newest first, optionally by status (draft | ready | posted). Each has its networks (${SOCIAL_NETWORKS.join(', ')}), one caption per network, an optional planned day, and either a branded graphic (copy + format) or uploaded files.`,
      auditClass: 'read',
      inputSchema: listInput,
      permission,
      handler: async (_ctx, input) => {
        const { status } = listInput.parse(input)
        return { posts: (await posts().list(status === undefined ? {} : { status })).map(withHref) }
      },
    },
    {
      name: 'brand.social_post_get',
      module: 'brand',
      summary: 'Read one social media post by id (Brand › Social).',
      auditClass: 'read',
      inputSchema: getInput,
      permission,
      handler: async (_ctx, input) => {
        const { postId } = getInput.parse(input)
        const post = await posts().get(postId)
        if (!post) throw new SocialPostError('not_found', `No social post ${postId}.`)
        return withHref(post)
      },
    },
    {
      name: 'brand.social_post_create',
      module: 'brand',
      summary: `Draft a social media post as a branded graphic in the company's active style (Brand › Social): title (internal name), format — ${formats} — the graphic's copy { headline, body, cta, mode light|dark }, the target networks, optional captions per network, status (default draft) and an optional plannedFor day (YYYY-MM-DD). The graphic is drawn from the active visual set; the person downloads it from the tab. For captions call brand.social_caption_suggest, show the variants, and save the chosen ones with brand.social_post_update. Nothing is posted to the networks.`,
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: { title?: string }) => `Drafted the social post “${input.title ?? 'untitled'}”`,
      inputSchema: createGraphicPostInputSchema,
      permission,
      handler: async (ctx, input) => withHref(await posts().createGraphic(createGraphicPostInputSchema.parse(input), actorOf(ctx))),
    },
    {
      name: 'brand.social_post_update',
      module: 'brand',
      summary:
        'Change a social media post (Brand › Social): title, networks, captions (replaces the whole map; one caption per targeted network), status (draft | ready | posted), plannedFor (YYYY-MM-DD or null), and for branded graphics the format and the graphic copy. Taking a network off drops its caption. Nothing is posted to the networks.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (_input: unknown, output?: SocialPost) => (output ? `Updated the social post “${output.title}”` : 'Updated a social post'),
      inputSchema: updatePostInputSchema,
      permission,
      handler: async (_ctx, input) => withHref(await posts().update(updatePostInputSchema.parse(input))),
    },
    {
      name: 'brand.social_caption_suggest',
      module: 'brand',
      summary:
        "Suggest 3 caption variants per network for a social media post, in the company's active brand voice (its examples, lexicon and glossary). networks defaults to the post's networks; locale picks the voice when several are active; brief adds the person's wishes. Saves nothing: show the variants and save what the person picks with brand.social_post_update.",
      auditClass: 'read',
      inputSchema: suggestInput,
      permission,
      handler: async (ctx, input) => {
        const i = suggestInput.parse(input)
        return suggestCaptions(
          { posts: posts(), brand: brand(), chat },
          {
            postId: i.postId,
            userId: ctx.principal.id,
            ...(i.networks ? { networks: i.networks } : {}),
            ...(i.locale ? { locale: i.locale } : {}),
            ...(i.brief ? { brief: i.brief } : {}),
          },
        )
      },
    },
  ]
}
