import { and, desc, eq } from 'drizzle-orm'
import type { DbHandle } from '$lib/kernel/db-stores'
import type { AppDatabase } from '$lib/server/db/context'
import { websiteContact, websiteContent } from '$lib/server/db/website.schema'

export type WebsiteContentKind = 'page' | 'doc'
export type WebsiteVisibility = 'private' | 'public'

export type WebsitePage = {
  id: string
  slug: string
  kind: WebsiteContentKind
  title: string
  body: string
  visibility: WebsiteVisibility
  /** ISO-8601 timestamps. */
  createdAt: string
  updatedAt: string
}

export type WebsiteContact = {
  id: string
  name: string | null
  email: string
  message: string | null
  source: string
  principalId: string | null
  createdAt: string
}

export type CreatePageInput = {
  slug: string
  title: string
  body: string
  kind?: WebsiteContentKind
  visibility?: WebsiteVisibility
}

export type UpdatePagePatch = {
  title?: string
  body?: string
}

export type ListPagesFilter = {
  kind?: WebsiteContentKind
  visibility?: WebsiteVisibility
}

export type CreateContactInput = {
  name?: string
  email: string
  message?: string
  principalId?: string
}

export type WebsiteStore = {
  createPage(input: CreatePageInput): Promise<WebsitePage>
  getPage(slug: string): Promise<WebsitePage | null>
  listPages(filter?: ListPagesFilter): Promise<WebsitePage[]>
  /** Throws loud when the slug is unknown. */
  updatePage(slug: string, patch: UpdatePagePatch): Promise<WebsitePage>
  /** The publish/unpublish flip. Throws loud when the slug is unknown. */
  setVisibility(slug: string, visibility: WebsiteVisibility): Promise<WebsitePage>
  createContact(input: CreateContactInput): Promise<WebsiteContact>
}

function requireSlugKnown(page: WebsitePage | null, slug: string): WebsitePage {
  if (!page) throw new Error(`unknown website page: ${slug}`)
  return page
}

function nowIso(): string {
  return new Date().toISOString()
}

/** In-memory WebsiteStore for tests and in-memory kernel wiring. */
export class InMemoryWebsiteStore implements WebsiteStore {
  private readonly pages = new Map<string, WebsitePage>()
  private readonly contacts: WebsiteContact[] = []

  async createPage(input: CreatePageInput): Promise<WebsitePage> {
    if (this.pages.has(input.slug)) {
      throw new Error(`duplicate website slug: ${input.slug}`)
    }
    const ts = nowIso()
    const page: WebsitePage = {
      id: crypto.randomUUID(),
      slug: input.slug,
      kind: input.kind ?? 'page',
      title: input.title,
      body: input.body,
      visibility: input.visibility ?? 'private',
      createdAt: ts,
      updatedAt: ts,
    }
    this.pages.set(page.slug, page)
    return page
  }

  async getPage(slug: string): Promise<WebsitePage | null> {
    return this.pages.get(slug) ?? null
  }

  async listPages(filter: ListPagesFilter = {}): Promise<WebsitePage[]> {
    return [...this.pages.values()].filter(
      (page) =>
        (filter.kind === undefined || page.kind === filter.kind) &&
        (filter.visibility === undefined || page.visibility === filter.visibility),
    )
  }

  async updatePage(slug: string, patch: UpdatePagePatch): Promise<WebsitePage> {
    const page = requireSlugKnown(this.pages.get(slug) ?? null, slug)
    const updated: WebsitePage = {
      ...page,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.body === undefined ? {} : { body: patch.body }),
      updatedAt: nowIso(),
    }
    this.pages.set(slug, updated)
    return updated
  }

  async setVisibility(slug: string, visibility: WebsiteVisibility): Promise<WebsitePage> {
    const page = requireSlugKnown(this.pages.get(slug) ?? null, slug)
    const updated: WebsitePage = { ...page, visibility, updatedAt: nowIso() }
    this.pages.set(slug, updated)
    return updated
  }

  async createContact(input: CreateContactInput): Promise<WebsiteContact> {
    const contact: WebsiteContact = {
      id: crypto.randomUUID(),
      name: input.name ?? null,
      email: input.email,
      message: input.message ?? null,
      source: 'website',
      principalId: input.principalId ?? null,
      createdAt: nowIso(),
    }
    this.contacts.push(contact)
    return contact
  }
}

type ContentRow = typeof websiteContent.$inferSelect
type ContactRow = typeof websiteContact.$inferSelect

function toPage(row: ContentRow): WebsitePage {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    body: row.body,
    visibility: row.visibility,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toContact(row: ContactRow): WebsiteContact {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    message: row.message,
    source: row.source,
    principalId: row.principalId,
    createdAt: row.createdAt.toISOString(),
  }
}

async function resolveDb(db: DbHandle): Promise<AppDatabase> {
  return typeof db === 'function' ? await db() : db
}

/**
 * WebsiteStore persisting to the website_content / website_contact tables.
 * Slug uniqueness is enforced by an explicit lookup plus the DB unique
 * constraint as backstop; both paths fail loud.
 */
export class DbWebsiteStore implements WebsiteStore {
  constructor(private readonly db: DbHandle) {}

  async createPage(input: CreatePageInput): Promise<WebsitePage> {
    const database = await resolveDb(this.db)
    const existing = await database
      .select({ id: websiteContent.id })
      .from(websiteContent)
      .where(eq(websiteContent.slug, input.slug))
      .limit(1)
    if (existing[0]) throw new Error(`duplicate website slug: ${input.slug}`)

    const rows = await database
      .insert(websiteContent)
      .values({
        slug: input.slug,
        kind: input.kind ?? 'page',
        title: input.title,
        body: input.body,
        visibility: input.visibility ?? 'private',
      })
      .returning()
    if (!rows[0]) throw new Error('website content insert returned no row')
    return toPage(rows[0])
  }

  async getPage(slug: string): Promise<WebsitePage | null> {
    const rows = await (
      await resolveDb(this.db)
    )
      .select()
      .from(websiteContent)
      .where(eq(websiteContent.slug, slug))
      .limit(1)
    return rows[0] ? toPage(rows[0]) : null
  }

  async listPages(filter: ListPagesFilter = {}): Promise<WebsitePage[]> {
    const conditions = [
      ...(filter.kind === undefined ? [] : [eq(websiteContent.kind, filter.kind)]),
      ...(filter.visibility === undefined ? [] : [eq(websiteContent.visibility, filter.visibility)]),
    ]
    const rows = await (await resolveDb(this.db))
      .select()
      .from(websiteContent)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(websiteContent.updatedAt))
    return rows.map(toPage)
  }

  async updatePage(slug: string, patch: UpdatePagePatch): Promise<WebsitePage> {
    const database = await resolveDb(this.db)
    const current = await database
      .select()
      .from(websiteContent)
      .where(eq(websiteContent.slug, slug))
      .limit(1)
    requireSlugKnown(current[0] ? toPage(current[0]) : null, slug)

    const rows = await database
      .update(websiteContent)
      .set({
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.body === undefined ? {} : { body: patch.body }),
        updatedAt: new Date(),
      })
      .where(eq(websiteContent.slug, slug))
      .returning()
    if (!rows[0]) throw new Error(`website page update returned no row: ${slug}`)
    return toPage(rows[0])
  }

  async setVisibility(slug: string, visibility: WebsiteVisibility): Promise<WebsitePage> {
    const database = await resolveDb(this.db)
    const current = await database
      .select()
      .from(websiteContent)
      .where(eq(websiteContent.slug, slug))
      .limit(1)
    requireSlugKnown(current[0] ? toPage(current[0]) : null, slug)

    const rows = await database
      .update(websiteContent)
      .set({ visibility, updatedAt: new Date() })
      .where(eq(websiteContent.slug, slug))
      .returning()
    if (!rows[0]) throw new Error(`website page visibility update returned no row: ${slug}`)
    return toPage(rows[0])
  }

  async createContact(input: CreateContactInput): Promise<WebsiteContact> {
    const rows = await (
      await resolveDb(this.db)
    )
      .insert(websiteContact)
      .values({
        name: input.name ?? null,
        email: input.email,
        message: input.message ?? null,
        source: 'website',
        principalId: input.principalId ?? null,
      })
      .returning()
    if (!rows[0]) throw new Error('website contact insert returned no row')
    return toContact(rows[0])
  }
}

/**
 * Production store handle: lazily resolves the request-scoped DB (when inside
 * a request/ALS context) or the pooled app handle, so importing/wiring never
 * opens a connection.
 */
export function defaultWebsiteStore(): WebsiteStore {
  const db: DbHandle = async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    const scoped = appDbAsyncLocal.getStore()
    if (scoped) return scoped
    return createScopedDrizzle(appSql)
  }
  return new DbWebsiteStore(db)
}
