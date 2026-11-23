import { WEBSITE_MODULE_ID } from './manifest'
import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import { isDirectHuman } from '$lib/kernel/principals'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import {
  createPageAudienceClassifier,
  liveAudienceChat,
  type PageAudienceClassifier,
  type PageDraft,
} from './page-audience'
import { buildSiteInfo, siteOrigin } from './site-info'
import { defaultWebsiteStore, type WebsitePage, type WebsiteStore } from './store'

/**
 * Kernel tool descriptors over the WebsiteStore. The store is injected
 * (tests pass an InMemoryWebsiteStore; production resolves the DB lazily per
 * operation via defaultWebsiteStore). Handlers stay thin — the registry
 * pipeline covers permissions, approval, audit, and vcs commits, and schemas
 * are parsed here for typed inputs (same idiom as the email module).
 */

export type WebsiteToolDeps = {
  store?: WebsiteStore
  /** This server's absolute origin; production reads the configured console ORIGIN. */
  origin?: () => string | Promise<string>
  /** Public website content or an internal document? Production: the LLM gateway (page-audience.ts). */
  classify?: PageAudienceClassifier
  /** The site's own host (ee's publicHost); null = none, the site lives on the console. Production: ee's status. */
  siteHost?: () => Promise<string | null>
}

/** Where internal documents go instead (named in descriptions and in the refusal). */
export const INTERNAL_DOCUMENT_TOOLS = ['drive.create_document', 'memory.create_text_file'] as const

/** One routing sentence every page-writing tool carries, so the agent never picks the website for internal documents. */
const PUBLIC_ONLY =
  'The website is the company’s public website: only content meant for visitors. Internal documents (pitch decks, project descriptions, funding/investor documents, plans, briefs, meeting notes) never go here, not even as a private page — save them to Drive as Markdown with drive.create_document, or to Memory › Documents with memory.create_text_file. Agent writes are checked and refused when the content is an internal document.'

async function configuredOrigin(): Promise<string> {
  const { env } = await import('$env/dynamic/private')
  return siteOrigin(env.ORIGIN)
}

/** ee's public website host; without ee there is none (any other ee failure stays loud). */
async function eeSiteHost(): Promise<string | null> {
  const { EeClient, SubstrateUnavailableError } = await import('$lib/server/ee/client')
  try {
    return (await new EeClient().status()).settings.publicHost
  } catch (err) {
    if (err instanceof SubstrateUnavailableError) return null
    throw err
  }
}

const createPageInput = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  kind: z.enum(['page', 'doc']).default('page'),
  visibility: z.enum(['private', 'public']).default('private'),
})

const updatePageInput = z.object({
  slug: z.string().min(1),
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
})

const publishPageInput = z.object({
  slug: z.string().min(1),
  visibility: z.enum(['public', 'private']),
})

const deletePageInput = z.object({
  slug: z.string().min(1),
})

const getPageInput = z.object({
  slug: z.string().min(1),
})

const listPagesInput = z.object({
  kind: z.enum(['page', 'doc']).optional(),
  visibility: z.enum(['private', 'public']).optional(),
})

/**
 * A page in the owner's words: its title when the call knows it, otherwise
 * its slug quoted as-is (a title is never invented from the slug).
 */
function pageName(title: string | undefined, slug: string): string {
  return title === undefined ? `the page “${slug}”` : `the ${title} page`
}

/**
 * The internal-document guard (Contribute: internal documents are never
 * website pages). Agent and service principals — and the brain acting for a
 * person (CB3) — only: a person writing their own page is never second-guessed. The model judges (page-audience.ts);
 * internal → the call is refused before anything is written, with the tools
 * to use instead.
 */
async function requirePublicContent(
  classify: PageAudienceClassifier,
  ctx: ToolContext,
  page: PageDraft,
): Promise<void> {
  if (isDirectHuman(ctx.principal)) return
  const verdict = await classify({ userId: ctx.principal.id, page })
  if (verdict.audience === 'public_website') return
  throw new KernelError(
    'invalid_input',
    `Not put on the website: “${page.title}” is an internal document, not public website content (${verdict.reason}). The website is the company’s public site. Save it to Drive as Markdown with drive.create_document, or to Memory › Documents with memory.create_text_file.`,
    { refused: 'internal_document', reason: verdict.reason, saveWith: [...INTERNAL_DOCUMENT_TOOLS] },
  )
}

/** Kernel descriptors for the website content surface. */
export function createWebsiteTools(deps: WebsiteToolDeps = {}): ToolDescriptor[] {
  const store = deps.store ?? defaultWebsiteStore()
  const origin = deps.origin ?? configuredOrigin
  const siteHost = deps.siteHost ?? eeSiteHost
  const classify = deps.classify ?? createPageAudienceClassifier({ chat: liveAudienceChat })

  return [
    {
      name: 'website.create_page',
      module: WEBSITE_MODULE_ID,
      summary: `Create one page of the public website (markdown body; kind page, or doc for public documentation such as a customer FAQ; visibility private = an unpublished draft of a public page, public = live). Fails loud on duplicate slug. ${PUBLIC_ONLY}`,
      auditClass: 'mutate',
      activity: (input: z.infer<typeof createPageInput>, output?: WebsitePage) =>
        `Created ${pageName(output?.title ?? input.title, input.slug)}`,
      inputSchema: createPageInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const parsed = createPageInput.parse(input)
        await requirePublicContent(classify, ctx, parsed)
        return store.createPage(parsed)
      },
    },
    {
      name: 'website.update_page',
      module: WEBSITE_MODULE_ID,
      summary: `Update title and/or body of one public website page by slug. Fails loud when the slug is unknown. ${PUBLIC_ONLY}`,
      auditClass: 'mutate',
      activity: (input: z.infer<typeof updatePageInput>, output?: WebsitePage) =>
        `Updated ${pageName(output?.title ?? input.title, input.slug)}`,
      inputSchema: updatePageInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const parsed = updatePageInput.parse(input)
        const current = await store.getPage(parsed.slug)
        // Unknown slug: nothing to judge — the store fails loud below.
        if (current && (parsed.title !== undefined || parsed.body !== undefined)) {
          await requirePublicContent(classify, ctx, {
            slug: current.slug,
            title: parsed.title ?? current.title,
            body: parsed.body ?? current.body,
            kind: current.kind,
            visibility: current.visibility,
          })
        }
        return store.updatePage(parsed.slug, {
          ...(parsed.title === undefined ? {} : { title: parsed.title }),
          ...(parsed.body === undefined ? {} : { body: parsed.body }),
        })
      },
    },
    {
      name: 'website.publish_page',
      module: WEBSITE_MODULE_ID,
      summary: `Flip the visibility of one website page between public (live on the public website) and private (draft). Fails loud when the slug is unknown. ${PUBLIC_ONLY}`,
      auditClass: 'mutate',
      activity: (input: z.infer<typeof publishPageInput>, output?: WebsitePage) =>
        input.visibility === 'public'
          ? `Published ${pageName(output?.title, input.slug)}`
          : `Made ${pageName(output?.title, input.slug)} private`,
      approvalRisk: 'public',
      inputSchema: publishPageInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const parsed = publishPageInput.parse(input)
        const current = parsed.visibility === 'public' ? await store.getPage(parsed.slug) : null
        // Going live is judged on the stored page; taking a page private never is.
        if (current) {
          await requirePublicContent(classify, ctx, {
            slug: current.slug,
            title: current.title,
            body: current.body,
            kind: current.kind,
            visibility: 'public',
          })
        }
        return store.setVisibility(parsed.slug, parsed.visibility)
      },
    },
    {
      name: 'website.delete_page',
      module: WEBSITE_MODULE_ID,
      summary:
        'Delete one website content object (page or doc) by slug, for good — it cannot be restored. Always waits for the owner’s approval, whatever the approval mode. Fails loud when the slug is unknown.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof deletePageInput>, output?: WebsitePage) =>
        output === undefined
          ? `Tried to delete ${pageName(undefined, input.slug)}`
          : `Deleted ${pageName(output.title, input.slug)}`,
      approvalRisk: 'destructive',
      approvalAlways: true,
      inputSchema: deletePageInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => store.deletePage(deletePageInput.parse(input).slug),
    },
    {
      name: 'website.get_page',
      module: WEBSITE_MODULE_ID,
      summary: 'Read one website content object by slug (any visibility).',
      auditClass: 'read',
      inputSchema: getPageInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => store.getPage(getPageInput.parse(input).slug),
    },
    {
      name: 'website.list_pages',
      module: WEBSITE_MODULE_ID,
      summary: 'List website content objects, optionally filtered by kind and/or visibility.',
      auditClass: 'read',
      inputSchema: listPagesInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const parsed = listPagesInput.parse(input)
        return store.listPages({
          ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
          ...(parsed.visibility === undefined ? {} : { visibility: parsed.visibility }),
        })
      },
    },
    {
      name: 'website.site_info',
      module: WEBSITE_MODULE_ID,
      summary:
        "Where the website is: {url, pages:[{slug,title,status,url}]} with absolute, openable links — on the site's own domain when it has one, else on this console (drafts link to the console, where the signed-in owner previews them). Use it to give the owner a link.",
      auditClass: 'read',
      inputSchema: z.object({}),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => {
        const [console_, host, pages] = await Promise.all([origin(), siteHost(), store.listPages()])
        return buildSiteInfo({ console: console_, site: host ? siteOrigin(host) : null }, pages)
      },
    },
  ]
}
