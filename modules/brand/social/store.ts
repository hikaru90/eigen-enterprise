import { randomUUID } from 'node:crypto'
import { asc, desc, eq, inArray } from 'drizzle-orm'
import type { DbHandle } from '$lib/kernel/db-stores'
import { brandSocialMedia, brandSocialPosts } from '$lib/server/db/brand.schema'
import {
  createGraphicPostInputSchema,
  SocialPostError,
  updatePostInputSchema,
  uploadPostFieldsSchema,
  type CreateGraphicPostInput,
  type SocialActor,
  type SocialCaptions,
  type SocialMedia,
  type SocialNetwork,
  type SocialPost,
  type SocialPostStatus,
  type UpdatePostInput,
  type UploadPostFields,
} from './types'

/**
 * The social post library (Brand › Social). The store owns the post rules so
 * every caller — the tab's routes and the assistant's kernel tools — gets the
 * same guards: graphics carry a format and their copy, uploads carry files
 * and no graphic, captions only for networks the post targets. Fail loud.
 */

export type NewMedia = { name: string; mime: string; size: number; sha256: string }

export type SocialPostStore = {
  list(filter?: { status?: SocialPostStatus }): Promise<SocialPost[]>
  get(postId: string): Promise<SocialPost | null>
  createGraphic(input: CreateGraphicPostInput, actor: SocialActor): Promise<SocialPost>
  /** An uploaded post with its files in order (the first is the cover). */
  createUpload(fields: UploadPostFields, media: readonly NewMedia[], actor: SocialActor): Promise<SocialPost>
  update(input: UpdatePostInput): Promise<SocialPost>
  /** Removes the post and its media rows; returns the media it had (the caller frees unreferenced bytes). */
  remove(postId: string): Promise<SocialMedia[]>
  getMedia(mediaId: string): Promise<SocialMedia | null>
  /** Whether any post still uses these bytes (blobs are content-addressed and shared). */
  blobInUse(sha256: string): Promise<boolean>
}

function actorColumns(actor: SocialActor): { createdBy: string; createdByKind: 'user' | 'agent' } {
  return actor.kind === 'user' ? { createdBy: actor.userId, createdByKind: 'user' } : { createdBy: actor.id, createdByKind: 'agent' }
}

/** Captions follow the networks: a network taken off the post takes its caption with it. */
function keepTargeted(captions: SocialCaptions, networks: readonly SocialNetwork[]): SocialCaptions {
  const out: SocialCaptions = {}
  for (const n of networks) if (captions[n] !== undefined) out[n] = captions[n]
  return out
}

function notFound(postId: string): never {
  throw new SocialPostError('not_found', `No social post ${postId}.`)
}

/** Applies a parsed patch to a post (shared by both stores). */
function patched(post: SocialPost, input: ReturnType<typeof updatePostInputSchema.parse>, now: string): SocialPost {
  if (post.source === 'upload' && (input.graphic !== undefined || input.format !== undefined)) {
    throw new SocialPostError('invalid', 'An uploaded post has no graphic or format to change; its files stay as uploaded.')
  }
  const networks = input.networks ?? post.networks
  if (input.captions) {
    const stray = Object.keys(input.captions).filter((n) => !networks.includes(n as SocialNetwork))
    if (stray.length) throw new SocialPostError('invalid', `Captions for networks the post does not target: ${stray.join(', ')}.`)
  }
  return {
    ...post,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.format === undefined ? {} : { format: input.format }),
    ...(input.graphic === undefined ? {} : { graphic: input.graphic }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.plannedFor === undefined ? {} : { plannedFor: input.plannedFor }),
    networks,
    captions: keepTargeted(input.captions ?? post.captions, networks),
    updatedAt: now,
  }
}

function validateMedia(media: readonly NewMedia[]): void {
  if (media.length === 0) throw new SocialPostError('invalid', 'An uploaded post needs at least one file.')
}

export class InMemorySocialPostStore implements SocialPostStore {
  private readonly posts = new Map<string, SocialPost>()
  private clock = 0

  private now(): string {
    // Strictly increasing so "newest first" is deterministic in tests.
    this.clock += 1
    return new Date(Date.UTC(2026, 0, 1) + this.clock * 1000).toISOString()
  }

  async list(filter: { status?: SocialPostStatus } = {}): Promise<SocialPost[]> {
    return [...this.posts.values()]
      .filter((p) => filter.status === undefined || p.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((p) => structuredClone(p))
  }

  async get(postId: string): Promise<SocialPost | null> {
    const post = this.posts.get(postId)
    return post ? structuredClone(post) : null
  }

  async createGraphic(input: CreateGraphicPostInput, actor: SocialActor): Promise<SocialPost> {
    const parsed = createGraphicPostInputSchema.parse(input)
    const now = this.now()
    const post: SocialPost = {
      id: randomUUID(),
      title: parsed.title,
      source: 'graphic',
      format: parsed.format,
      graphic: parsed.graphic,
      networks: parsed.networks,
      captions: parsed.captions,
      status: parsed.status,
      plannedFor: parsed.plannedFor,
      media: [],
      ...actorColumns(actor),
      createdAt: now,
      updatedAt: now,
    }
    this.posts.set(post.id, post)
    return structuredClone(post)
  }

  async createUpload(fields: UploadPostFields, media: readonly NewMedia[], actor: SocialActor): Promise<SocialPost> {
    const parsed = uploadPostFieldsSchema.parse(fields)
    validateMedia(media)
    const now = this.now()
    const id = randomUUID()
    const post: SocialPost = {
      id,
      title: parsed.title,
      source: 'upload',
      format: null,
      graphic: null,
      networks: parsed.networks,
      captions: parsed.captions,
      status: parsed.status,
      plannedFor: parsed.plannedFor,
      media: media.map((m, position) => ({ id: randomUUID(), postId: id, position, ...m })),
      ...actorColumns(actor),
      createdAt: now,
      updatedAt: now,
    }
    this.posts.set(id, post)
    return structuredClone(post)
  }

  async update(input: UpdatePostInput): Promise<SocialPost> {
    const parsed = updatePostInputSchema.parse(input)
    const post = this.posts.get(parsed.postId) ?? notFound(parsed.postId)
    const next = patched(post, parsed, this.now())
    this.posts.set(next.id, next)
    return structuredClone(next)
  }

  async remove(postId: string): Promise<SocialMedia[]> {
    const post = this.posts.get(postId) ?? notFound(postId)
    this.posts.delete(postId)
    return post.media
  }

  async getMedia(mediaId: string): Promise<SocialMedia | null> {
    for (const p of this.posts.values()) {
      const m = p.media.find((x) => x.id === mediaId)
      if (m) return { ...m }
    }
    return null
  }

  async blobInUse(sha256: string): Promise<boolean> {
    return [...this.posts.values()].some((p) => p.media.some((m) => m.sha256 === sha256))
  }
}

type PostRow = typeof brandSocialPosts.$inferSelect
type MediaRow = typeof brandSocialMedia.$inferSelect

function toMedia(row: MediaRow): SocialMedia {
  return { id: row.id, postId: row.postId, position: row.position, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256 }
}

function toPost(row: PostRow, media: MediaRow[]): SocialPost {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    format: row.format,
    graphic: row.graphic,
    networks: row.networks as SocialNetwork[],
    captions: row.captions as SocialCaptions,
    status: row.status,
    plannedFor: row.plannedFor,
    media: media.filter((m) => m.postId === row.id).sort((a, b) => a.position - b.position).map(toMedia),
    createdBy: row.createdBy,
    createdByKind: row.createdByKind,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function resolveDb(db: DbHandle) {
  return typeof db === 'function' ? await db() : db
}

/** The library on the brand_social_* tables (migration 0153); CHECKs back the store rules. */
export class DbSocialPostStore implements SocialPostStore {
  constructor(private readonly db: DbHandle) {}

  private async withMedia(rows: PostRow[]): Promise<SocialPost[]> {
    if (rows.length === 0) return []
    const database = await resolveDb(this.db)
    const media = await database
      .select()
      .from(brandSocialMedia)
      .where(inArray(brandSocialMedia.postId, rows.map((r) => r.id)))
    return rows.map((r) => toPost(r, media))
  }

  async list(filter: { status?: SocialPostStatus } = {}): Promise<SocialPost[]> {
    const database = await resolveDb(this.db)
    const base = database.select().from(brandSocialPosts)
    const rows = await (filter.status === undefined ? base : base.where(eq(brandSocialPosts.status, filter.status))).orderBy(
      desc(brandSocialPosts.createdAt),
    )
    return this.withMedia(rows)
  }

  async get(postId: string): Promise<SocialPost | null> {
    const database = await resolveDb(this.db)
    const rows = await database.select().from(brandSocialPosts).where(eq(brandSocialPosts.id, postId)).limit(1)
    const [post] = await this.withMedia(rows)
    return post ?? null
  }

  async createGraphic(input: CreateGraphicPostInput, actor: SocialActor): Promise<SocialPost> {
    const parsed = createGraphicPostInputSchema.parse(input)
    const database = await resolveDb(this.db)
    const rows = await database
      .insert(brandSocialPosts)
      .values({
        title: parsed.title,
        source: 'graphic',
        format: parsed.format,
        graphic: parsed.graphic,
        networks: parsed.networks,
        captions: parsed.captions,
        status: parsed.status,
        plannedFor: parsed.plannedFor,
        ...actorColumns(actor),
      })
      .returning()
    if (!rows[0]) throw new Error('brand social post insert returned no row')
    return toPost(rows[0], [])
  }

  async createUpload(fields: UploadPostFields, media: readonly NewMedia[], actor: SocialActor): Promise<SocialPost> {
    const parsed = uploadPostFieldsSchema.parse(fields)
    validateMedia(media)
    const database = await resolveDb(this.db)
    return database.transaction(async (tx) => {
      const rows = await tx
        .insert(brandSocialPosts)
        .values({
          title: parsed.title,
          source: 'upload',
          format: null,
          graphic: null,
          networks: parsed.networks,
          captions: parsed.captions,
          status: parsed.status,
          plannedFor: parsed.plannedFor,
          ...actorColumns(actor),
        })
        .returning()
      const post = rows[0]
      if (!post) throw new Error('brand social post insert returned no row')
      const mediaRows = await tx
        .insert(brandSocialMedia)
        .values(media.map((m, position) => ({ postId: post.id, position, ...m })))
        .returning()
      return toPost(post, mediaRows)
    })
  }

  async update(input: UpdatePostInput): Promise<SocialPost> {
    const parsed = updatePostInputSchema.parse(input)
    const current = (await this.get(parsed.postId)) ?? notFound(parsed.postId)
    const next = patched(current, parsed, new Date().toISOString())
    const database = await resolveDb(this.db)
    const rows = await database
      .update(brandSocialPosts)
      .set({
        title: next.title,
        format: next.format,
        graphic: next.graphic,
        networks: next.networks,
        captions: next.captions,
        status: next.status,
        plannedFor: next.plannedFor,
        updatedAt: new Date(next.updatedAt),
      })
      .where(eq(brandSocialPosts.id, parsed.postId))
      .returning()
    if (!rows[0]) notFound(parsed.postId)
    return { ...toPost(rows[0], []), media: current.media }
  }

  async remove(postId: string): Promise<SocialMedia[]> {
    const database = await resolveDb(this.db)
    const media = await database.select().from(brandSocialMedia).where(eq(brandSocialMedia.postId, postId)).orderBy(asc(brandSocialMedia.position))
    const rows = await database.delete(brandSocialPosts).where(eq(brandSocialPosts.id, postId)).returning({ id: brandSocialPosts.id })
    if (!rows[0]) notFound(postId)
    return media.map(toMedia)
  }

  async getMedia(mediaId: string): Promise<SocialMedia | null> {
    const database = await resolveDb(this.db)
    const rows = await database.select().from(brandSocialMedia).where(eq(brandSocialMedia.id, mediaId)).limit(1)
    return rows[0] ? toMedia(rows[0]) : null
  }

  async blobInUse(sha256: string): Promise<boolean> {
    const database = await resolveDb(this.db)
    const rows = await database.select({ id: brandSocialMedia.id }).from(brandSocialMedia).where(eq(brandSocialMedia.sha256, sha256)).limit(1)
    return rows.length > 0
  }
}

/** Production handle: the request-scoped DB when inside one, else the pooled app handle (same idiom as defaultBrandStore). */
export function defaultSocialPostStore(): SocialPostStore {
  const db: DbHandle = async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    const scoped = appDbAsyncLocal.getStore()
    if (scoped) return scoped
    return createScopedDrizzle(appSql)
  }
  return new DbSocialPostStore(db)
}
