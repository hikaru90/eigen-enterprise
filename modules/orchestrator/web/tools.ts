import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { KernelError } from '$lib/kernel/errors'
import { isLlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ChatAttachment } from '$lib/server/llm/llm-client'
import { detectImageMime, isPdfBytes, VisionReadError, type llmLookAt } from '$lib/server/llm/vision'
import type { llmWebSearch } from '$lib/server/llm/web-search'
import { WebFetchError, type fetchPublicUrl } from '$lib/server/web/fetch-page'
import { htmlToReadable } from '$lib/server/web/readable'
import { ORCHESTRATOR_MODULE_ID } from '../manifest'

/**
 * The AI's browser (wish 133f8e82: "let the AI co-workers open links … no browser, no web
 * search"): web.fetch opens one public URL and returns its readable text (an image or PDF is
 * looked at by a vision model through the gateway), web.search searches the web through the
 * gateway (OpenRouter's web search). Both are reads, for people, co-workers (role member) and
 * agents; every model call they make goes through the gateway onto the cost ledger.
 */

export type WebToolPorts = {
  fetch: typeof fetchPublicUrl
  lookAt: typeof llmLookAt
  search: typeof llmWebSearch
}

async function livePorts(): Promise<WebToolPorts> {
  const [{ fetchPublicUrl }, { llmLookAt }, { llmWebSearch }] = await Promise.all([
    import('$lib/server/web/fetch-page'),
    import('$lib/server/llm/vision'),
    import('$lib/server/llm/web-search'),
  ])
  return { fetch: fetchPublicUrl, lookAt: llmLookAt, search: llmWebSearch }
}

/** Characters of page text one call returns at most (about 15k tokens). */
export const WEB_FETCH_MAX_CHARS = 60_000

const fetchInput = z
  .object({
    url: z.string().min(1).max(4096),
    question: z.string().max(2000).optional(),
  })
  .strict()

const searchInput = z
  .object({
    query: z.string().trim().min(1).max(500),
    max_results: z.number().int().min(1).max(10).optional(),
  })
  .strict()

const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/rss+xml', 'application/atom+xml', 'application/ld+json'])
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

function asKernelError(err: unknown): never {
  if (err instanceof WebFetchError || err instanceof VisionReadError) throw new KernelError('invalid_input', err.message)
  if (isLlmNotConfiguredError(err)) throw new KernelError('not_configured', (err as Error).message)
  throw err
}

function cap(text: string, truncated: boolean): { text: string; truncated: boolean } {
  if (text.length <= WEB_FETCH_MAX_CHARS) return { text, truncated }
  return { text: text.slice(0, WEB_FETCH_MAX_CHARS), truncated: true }
}

async function openUrl(ports: WebToolPorts, ctx: ToolContext, input: z.infer<typeof fetchInput>) {
  const page = await ports.fetch(input.url).catch(asKernelError)
  const base = { url: page.url, status: page.status, content_type: page.contentType }
  const bytes = new Uint8Array(page.body)
  const image = detectImageMime(bytes)
  if (image || isPdfBytes(bytes)) {
    if (page.truncated) {
      throw new KernelError('invalid_input', `${page.url} is larger than the ${Math.round(page.body.length / 1024 / 1024)} MB that can be opened.`)
    }
    const name = new URL(page.url).pathname.split('/').pop() || page.url
    const base64 = page.body.toString('base64')
    const attachment: ChatAttachment = image ? { type: 'image', mime: image, base64 } : { type: 'pdf', filename: name, base64 }
    const seen = await ports
      .lookAt({ userId: ctx.principal.id, task: 'web.image_read', name, attachment, ...(input.question ? { question: input.question } : {}) })
      .catch(asKernelError)
    return { ...base, kind: image ? 'image' : 'pdf', title: name, text: seen.text, truncated: false }
  }
  if (HTML_TYPES.has(page.contentType)) {
    const readable = htmlToReadable(page.body.toString('utf8'), page.url)
    return { ...base, kind: 'html', title: readable.title, ...cap(readable.text, page.truncated) }
  }
  if (page.contentType.startsWith('text/') || TEXT_TYPES.has(page.contentType) || page.contentType.endsWith('+json') || page.contentType.endsWith('+xml')) {
    return { ...base, kind: 'text', title: '', ...cap(page.body.toString('utf8'), page.truncated) }
  }
  throw new KernelError(
    'invalid_input',
    `${page.url} is ${page.contentType || 'of an unnamed type'}; web.fetch reads web pages, text, PDFs and images (PNG, JPEG, WebP).`,
  )
}

export function createWebTools(opts: { ports?: () => Promise<WebToolPorts> } = {}): ToolDescriptor[] {
  const ports = opts.ports ?? livePorts
  const roles = ['admin', 'member', 'agent']
  return [
    {
      name: 'web.fetch',
      module: ORCHESTRATOR_MODULE_ID,
      summary:
        'Open a public web link (http/https) and read it: a page comes back as its title and readable text (links as "label (url)"), a PDF or an image (PNG, JPEG, WebP) as what a vision model sees in it (question: what to look for). Private and local addresses are refused; at most 5 MB, 15 seconds and 60,000 characters (truncated says when it was cut).',
      auditClass: 'read',
      inputSchema: fetchInput,
      permission: { roles },
      handler: async (ctx, input) => openUrl(await ports(), ctx, fetchInput.parse(input)),
    },
    {
      name: 'web.search',
      module: ORCHESTRATOR_MODULE_ID,
      summary:
        'Search the web (query; max_results 1–10, default 5): a short answer from the results and the sources it cites (title, url, snippet). Open a source with web.fetch. Runs on OpenRouter web search; on another provider it says what to switch on.',
      auditClass: 'read',
      inputSchema: searchInput,
      permission: { roles },
      handler: async (ctx, input) => {
        const i = searchInput.parse(input)
        const p = await ports()
        return p.search({ userId: ctx.principal.id, query: i.query, ...(i.max_results ? { maxResults: i.max_results } : {}) }).catch(asKernelError)
      },
    },
  ]
}
