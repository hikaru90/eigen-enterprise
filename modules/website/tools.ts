import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
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
}

async function configuredOrigin(): Promise<string> {
  const { env } = await import('$env/dynamic/private')
  return siteOrigin(env.ORIGIN)
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

/** Kernel descriptors for the website content surface. */
export function createWebsiteTools(deps: WebsiteToolDeps = {}): ToolDescriptor[] {
  const store = deps.store ?? defaultWebsiteStore()
  const origin = deps.origin ?? configuredOrigin

  return [
    {
      name: 'website.create_page',
      module: 'website',
      summary:
        'Create one website content object (markdown body, kind page|doc, visibility private|public). Fails loud on duplicate slug.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof createPageInput>, output?: WebsitePage) =>
        `Created ${pageName(output?.title ?? input.title, input.slug)}`,
      inputSchema: createPageInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => store.createPage(createPageInput.parse(input)),
    },
    {
      name: 'website.update_page',
      module: 'website',
      summary:
        'Update title and/or body of one website content object by slug. Fails loud when the slug is unknown.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof updatePageInput>, output?: WebsitePage) =>
        `Updated ${pageName(output?.title ?? input.title, input.slug)}`,
      inputSchema: updatePageInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const parsed = updatePageInput.parse(input)
        return store.updatePage(parsed.slug, {
          ...(parsed.title === undefined ? {} : { title: parsed.title }),
          ...(parsed.body === undefined ? {} : { body: parsed.body }),
        })
      },
    },
    {
      name: 'website.publish_page',
      module: 'website',
      summary:
        'Flip the visibility of one website content object between public and private. Fails loud when the slug is unknown.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof publishPageInput>, output?: WebsitePage) =>
        input.visibility === 'public'
          ? `Published ${pageName(output?.title, input.slug)}`
          : `Made ${pageName(output?.title, input.slug)} private`,
      approvalRisk: 'public',
      inputSchema: publishPageInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const parsed = publishPageInput.parse(input)
        return store.setVisibility(parsed.slug, parsed.visibility)
      },
    },
    {
      name: 'website.get_page',
      module: 'website',
      summary: 'Read one website content object by slug (any visibility).',
      auditClass: 'read',
      inputSchema: getPageInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => store.getPage(getPageInput.parse(input).slug),
    },
    {
      name: 'website.list_pages',
      module: 'website',
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
      module: 'website',
      summary:
        'Where the website is on this server: {url, pages:[{slug,title,status,url}]} with absolute, openable links (drafts are previewable by the signed-in owner). Use it to give the owner a link.',
      auditClass: 'read',
      inputSchema: z.object({}),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => buildSiteInfo(await origin(), await store.listPages()),
    },
  ]
}
