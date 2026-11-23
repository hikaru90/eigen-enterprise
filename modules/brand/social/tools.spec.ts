import type { CaptionChat } from './captions'
import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { InMemoryBrandStore } from '../store'
import { InMemorySocialPostStore } from './store'
import { createSocialMediaService, type SocialBlobStore } from './media'
import { createBrandSocialTools } from './tools'

/** The company brain acting as Ana (CB3: the principal IS the person). */
const agentCtx: ToolContext = {
  principal: delegatedPrincipal({ id: 'ana', roles: ['admin', 'member'] }, 'orchestrator'),
  requestId: 'req-1',
}

const draft = {
  title: 'Launch teaser',
  format: 'story',
  graphic: { headline: 'Something new', body: 'Next week.', cta: 'Stay tuned', mode: 'dark' },
  networks: ['instagram', 'tiktok'],
}

async function wired(chat: CaptionChat = async () => ({ choices: [] })) {
  const posts = new InMemorySocialPostStore()
  const events = new InMemoryEventSink()
  const activations = new InMemoryActivationStore()
  await activations.set('brand', true)
  const registry = new KernelRegistry({
    eventSink: events,
    activationStore: activations,
    approvalStore: new InMemoryApprovalStore(),
    vcsCommitter: null,
  })
  for (const d of createBrandSocialTools({ posts, brand: new InMemoryBrandStore(), chat })) registry.register(d)
  return { posts, registry, events }
}

describe('brand social tools', () => {
  it('declares reads read and writes as internal mutations, open to the assistant', () => {
    const tools = createBrandSocialTools({ posts: new InMemorySocialPostStore(), brand: new InMemoryBrandStore() })
    const by = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(Object.keys(by).sort()).toEqual([
      'brand.social_caption_suggest',
      'brand.social_post_create',
      'brand.social_post_delete',
      'brand.social_post_get',
      'brand.social_post_list',
      'brand.social_post_update',
      'brand.social_post_upload',
    ])
    expect(by['brand.social_post_upload']).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    expect(by['brand.social_post_delete']).toMatchObject({ auditClass: 'mutate', approvalRisk: 'destructive' })
    for (const name of ['brand.social_post_list', 'brand.social_post_get', 'brand.social_caption_suggest']) expect(by[name].auditClass).toBe('read')
    for (const name of ['brand.social_post_create', 'brand.social_post_update']) {
      expect(by[name]).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    }
    for (const t of tools) expect(t.permission.roles).toEqual(['admin', 'member', 'agent'])
    expect(by['brand.social_post_create'].summary).toMatch(/Nothing is posted/)
  })

  it('the assistant drafts a graphic post, edits it and lists it, through the kernel', async () => {
    const { posts, registry, events } = await wired()
    const created = (await registry.execute('brand.social_post_create', draft, agentCtx)) as { id: string; href: string; createdByKind: string }
    // CB3: the actor is the person the brain acts as (provenance via the brain is in the audit event).
    expect(created).toMatchObject({ createdByKind: 'user', href: `/brand/social?post=${created.id}` })
    await registry.execute('brand.social_post_update', { postId: created.id, captions: { instagram: 'Soon.' }, status: 'ready' }, agentCtx)
    await expect(posts.get(created.id)).resolves.toMatchObject({ status: 'ready', captions: { instagram: 'Soon.' } })
    const listed = (await registry.execute('brand.social_post_list', { status: 'ready' }, agentCtx)) as { posts: Array<{ id: string }> }
    expect(listed.posts.map((p) => p.id)).toEqual([created.id])
    const got = (await registry.execute('brand.social_post_get', { postId: created.id }, agentCtx)) as { title: string }
    expect(got.title).toBe('Launch teaser')
    const activity = events.events.map((e) => (e.payload as { activity?: string } | null)?.activity).filter(Boolean)
    expect(activity).toContain('Drafted the social post “Launch teaser”')
  })

  it('refuses an unknown format at the schema', async () => {
    const { registry } = await wired()
    await expect(registry.execute('brand.social_post_create', { ...draft, format: 'banner' }, agentCtx)).rejects.toThrow()
  })

  it('caption suggestions run on the acting person’s gateway identity', async () => {
    const seen: string[] = []
    const chat: CaptionChat = async (input) => {
      seen.push(input.userId)
      return { choices: [{ message: { content: JSON.stringify({ captions: { tiktok: ['a', 'b', 'c'] } }) } }] }
    }
    const { registry } = await wired(chat)
    const created = (await registry.execute('brand.social_post_create', draft, agentCtx)) as { id: string }
    const out = await registry.execute('brand.social_caption_suggest', { postId: created.id, networks: ['tiktok'] }, agentCtx)
    expect(out).toMatchObject({ captions: { tiktok: ['a', 'b', 'c'] }, voice: false })
    expect(seen).toEqual(['ana'])
  })

  it('uploads a post with base64 files and deletes it with its files, through the same media service as the route', async () => {
    const posts = new InMemorySocialPostStore()
    const stored = new Map<string, Uint8Array>()
    const blobs: SocialBlobStore = {
      put: async (bytes) => {
        const sha = `sha-${stored.size}`
        stored.set(sha, bytes)
        return { sha256: sha, size: bytes.byteLength }
      },
      get: async (sha) => stored.get(sha)!,
      remove: async (sha) => void stored.delete(sha),
    }
    const media = createSocialMediaService({ posts, blobs, maxUploadBytes: 8 })
    const by = Object.fromEntries(
      createBrandSocialTools({ posts, brand: new InMemoryBrandStore(), media: () => media }).map((t) => [t.name, t]),
    )
    const png = Buffer.from([1, 2, 3]).toString('base64')
    const post = (await by['brand.social_post_upload'].handler(agentCtx, {
      title: 'Team photo',
      networks: ['instagram'],
      captions: { instagram: 'Hi.' },
      files: [{ filename: 'team.png', mime: 'image/png', dataB64: png }],
    })) as { id: string; createdByKind: string; href: string }
    expect(post).toMatchObject({ createdByKind: 'user', href: `/brand/social?post=${post.id}` })
    expect(stored.size).toBe(1)
    // The route's limits: the upload size and the media types.
    const big = Buffer.alloc(9, 1).toString('base64')
    await expect(
      by['brand.social_post_upload'].handler(agentCtx, { title: 'x', networks: ['instagram'], files: [{ filename: 'a.png', mime: 'image/png', dataB64: big }] }),
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      by['brand.social_post_upload'].handler(agentCtx, { title: 'x', networks: ['instagram'], files: [{ filename: 'a.png', mime: 'image/png', dataB64: 'no!' }] }),
    ).rejects.toThrow()
    await expect(by['brand.social_post_delete'].handler(agentCtx, { postId: post.id })).resolves.toEqual({ deleted: post.id })
    await expect(posts.get(post.id)).resolves.toBeNull()
    expect(stored.size).toBe(0)
  })
})
