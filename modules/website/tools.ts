import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { defaultWebsiteStore, type WebsiteStore } from './store'

/**
 * Kernel tool descriptors over the WebsiteStore. The store is injected
 * (tests pass an InMemoryWebsiteStore; production resolves the DB lazily per
 * operation via defaultWebsiteStore). Handlers stay thin — the registry
 * pipeline covers permissions, approval, audit, and vcs commits, and schemas
 * are parsed here for typed inputs (same idiom as the email module).
 */

export type WebsiteToolDeps = {
  store?: WebsiteStore
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

/** Kernel descriptors for the website content surface. */
export function createWebsiteTools(deps: WebsiteToolDeps = {}): ToolDescriptor[] {
  const store = deps.store ?? defaultWebsiteStore()

  return [
    {
      name: 'website.create_page',
      module: 'website',
      summary:
        'Create one website content object (markdown body, kind page|doc, visibility private|public). Fails loud on duplicate slug.',
      auditClass: 'mutate',
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
  ]
}
