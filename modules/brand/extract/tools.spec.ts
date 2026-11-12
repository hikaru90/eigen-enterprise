import { describe, expect, it, vi } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { expandSeeds } from '../style-format/expand'
import { validSeeds } from '../style-format/seeds.spec'
import { BrowserUnavailableError } from './capture-errors'
import { GuideUploadError } from './guide'
import { InMemoryBrandExtractionStore } from './store'
import { createBrandExtractTools, type BrandExtractToolDeps } from './tools'

const humanAdmin: ToolContext = {
  principal: { id: 'owner-1', kind: 'human', roles: ['admin'] },
  requestId: 'req-1',
}

const agentPrincipal: ToolContext = {
  principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] },
  requestId: 'req-2',
}

function fakeCapture() {
  return vi.fn(async (url: string) => ({
    facts: {
      selectors: {},
      themeColor: null,
      title: 'Captured Site',
      colorCensus: [{ color: '#22e876', count: 5 }],
    },
    screenshotB64: 'c2hvdA==',
    title: 'Captured Site',
    ...(url ? {} : {}),
  }))
}

function fakePropose() {
  const expanded = expandSeeds(validSeeds())
  const candidate = (label: string) => ({
    label,
    seeds: validSeeds(),
    cssVars: expanded.cssVars,
    darkCssVars: expanded.darkCssVars,
  })
  return vi.fn(
    async () =>
      [
        candidate('Color-led'),
        { label: 'Type-led', error: 'invalid json' },
        candidate('Structure-led'),
      ] satisfies import('./propose').ProposedCandidate[],
  )
}

function wiredRegistry(deps: BrandExtractToolDeps = {}) {
  const store = deps.store ?? new InMemoryBrandExtractionStore()
  const activations = new InMemoryActivationStore()
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    activationStore: activations,
    approvalStore: new InMemoryApprovalStore(),
    vcsCommitter: null,
  })
  for (const descriptor of createBrandExtractTools({ store, ...deps }))
    registry.register(descriptor)
  return { store, registry, activations }
}

describe('brand extraction tools', () => {
  it('descriptor surface: external/mutate audit classes and admin-only roles', () => {
    const tools = createBrandExtractTools({
      store: new InMemoryBrandExtractionStore(),
      capture: fakeCapture(),
      propose: fakePropose(),
    })
    expect(tools.map((t) => t.name)).toEqual([
      'brand.extract_start',
      'brand.extract_guide_start',
      'brand.extract_propose',
      'brand.extract_judge',
      'brand.extract_accept',
      'brand.extract_session_get',
    ])
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.get('brand.extract_start')!.auditClass).toBe('external')
    expect(byName.get('brand.extract_guide_start')!.auditClass).toBe('mutate')
    expect(byName.get('brand.extract_propose')!.auditClass).toBe('external')
    expect(byName.get('brand.extract_judge')!.auditClass).toBe('mutate')
    expect(byName.get('brand.extract_accept')!.auditClass).toBe('mutate')
    expect(byName.get('brand.extract_session_get')!.auditClass).toBe('read')
    for (const descriptor of tools) {
      if (descriptor.auditClass === 'read') {
        expect(descriptor.permission.roles).toEqual(['admin', 'agent'])
      } else {
        expect(descriptor.permission.roles).toEqual(['admin'])
      }
    }
  })

  it('extract_start captures the site and stores round 0 facts', async () => {
    const capture = fakeCapture()
    const { registry, activations } = wiredRegistry({ capture })
    await activations.set('brand', true)
    const result = (await registry.execute(
      'brand.extract_start',
      { url: 'https://example.com' },
      humanAdmin,
    )) as { sessionId: string; title: string; digestSummary: string }
    expect(result.title).toBe('Captured Site')
    expect(result.digestSummary).toContain('SITE: Captured Site')
    expect(capture).toHaveBeenCalledWith('https://example.com')
  })

  it('extract_start passes the typed no-browser failure through and opens no session', async () => {
    const store = new InMemoryBrandExtractionStore()
    const capture = vi.fn(async () => {
      throw new BrowserUnavailableError('/opt/pw/chrome-headless-shell')
    })
    const createSession = vi.spyOn(store, 'createSession')
    const { registry, activations } = wiredRegistry({ store, capture })
    await activations.set('brand', true)
    await expect(
      registry.execute('brand.extract_start', { url: 'https://example.com' }, humanAdmin),
    ).rejects.toBeInstanceOf(BrowserUnavailableError)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('extract_start is human-only (G8): agents get permission_denied', async () => {
    const { registry, activations } = wiredRegistry({ capture: fakeCapture() })
    await activations.set('brand', true)
    await expect(
      registry.execute('brand.extract_start', { url: 'https://example.com' }, agentPrincipal),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('judge/accept mutations are human-only too', async () => {
    const { store, registry, activations } = wiredRegistry({ capture: fakeCapture() })
    await activations.set('brand', true)
    const session = await store.createSession({ url: 'https://example.com', title: 'x' })
    for (const [tool, input] of [
      ['brand.extract_judge', { sessionId: session.id, round: 0, chosen: null }],
      ['brand.extract_accept', { sessionId: session.id, name: 'x' }],
    ] as const) {
      await expect(registry.execute(tool, input, agentPrincipal)).rejects.toMatchObject({
        code: 'permission_denied',
      })
    }
  })

  it('the full judge loop runs through the registry: start -> propose -> judge -> accept', async () => {
    const propose = fakePropose()
    const { store, registry, activations } = wiredRegistry({
      capture: fakeCapture(),
      propose,
    })
    await activations.set('brand', true)

    const started = (await registry.execute(
      'brand.extract_start',
      { url: 'https://example.com' },
      humanAdmin,
    )) as { sessionId: string }

    const proposed = (await registry.execute(
      'brand.extract_propose',
      { sessionId: started.sessionId },
      humanAdmin,
    )) as { round: number; candidates: Array<{ label: string }> }
    expect(proposed.round).toBe(1)
    expect(proposed.candidates.map((c) => c.label)).toEqual([
      'Color-led',
      'Type-led',
      'Structure-led',
    ])
    expect(propose).toHaveBeenCalledTimes(1)

    await registry.execute(
      'brand.extract_judge',
      { sessionId: started.sessionId, round: 1, chosen: 0, note: 'closest' },
      humanAdmin,
    )

    const accepted = (await registry.execute(
      'brand.extract_accept',
      { sessionId: started.sessionId, name: 'Kindred web' },
      humanAdmin,
    )) as { stagedId: string; corpusItem: { provenance: { source: string } } }
    expect(accepted.corpusItem.provenance.source).toBe('extraction')

    const session = await store.requireSession(started.sessionId)
    expect(session.status).toBe('accepted')
  })

  it('extract_accept fails loud without a judged round', async () => {
    const { store, registry, activations } = wiredRegistry({ capture: fakeCapture() })
    await activations.set('brand', true)
    const session = await store.createSession({ url: 'https://example.com', title: 'x' })
    await expect(
      registry.execute('brand.extract_accept', { sessionId: session.id, name: 'x' }, humanAdmin),
    ).rejects.toThrow(/no judged round/)
  })

  it('extract_session_get returns rounds (agents may read) and fails loud on unknown ids', async () => {
    const { store, registry, activations } = wiredRegistry({ capture: fakeCapture() })
    await activations.set('brand', true)
    const session = await sessionFixture(store)
    const result = (await registry.execute(
      'brand.extract_session_get',
      { sessionId: session.id },
      agentPrincipal,
    )) as { session: { id: string }; rounds: number[] }
    expect(result.session.id).toBe(session.id)
    expect(result.rounds).toHaveLength(1)
    await expect(
      registry.execute(
        'brand.extract_session_get',
        { sessionId: '0b8f8d9e-6a1e-4b3e-9c2f-1a2b3c4d5e6f' },
        agentPrincipal,
      ),
    ).rejects.toThrow(/unknown brand extraction session/)
  })

  it('propose carries the judge feedback of prior rounds into the next gateway call', async () => {
    const propose = fakePropose()
    const { registry, activations } = wiredRegistry({
      capture: fakeCapture(),
      propose,
    })
    await activations.set('brand', true)
    const started = (await registry.execute(
      'brand.extract_start',
      { url: 'https://example.com' },
      humanAdmin,
    )) as { sessionId: string }
    await registry.execute('brand.extract_propose', { sessionId: started.sessionId }, humanAdmin)
    await registry.execute(
      'brand.extract_judge',
      { sessionId: started.sessionId, round: 1, chosen: null, note: 'too muted' },
      humanAdmin,
    )
    await registry.execute('brand.extract_propose', { sessionId: started.sessionId }, humanAdmin)
    const secondRoundInputs = propose.mock.calls[1][0]
    expect(secondRoundInputs.priorRounds).toHaveLength(1)
    expect(secondRoundInputs.priorRounds[0].verdict).toEqual({ chosen: null, note: 'too muted' })
    expect(secondRoundInputs.userId).toBe('owner-1')
  })
})

describe('brand guide upload tools', () => {
  // "%PDF-1.7\n" and a PNG signature: the format, not the name, decides the type.
  const PDF_B64 = 'JVBERi0xLjcK'
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='

  it('extract_guide_start stores the guide with a new session and records round 0 without a screenshot', async () => {
    const { store, registry, activations } = wiredRegistry()
    await activations.set('brand', true)
    const started = (await registry.execute(
      'brand.extract_guide_start',
      { filename: 'Kindred CI.pdf', dataB64: PDF_B64 },
      humanAdmin,
    )) as { sessionId: string; title: string; guide: unknown }
    expect(started.title).toBe('Kindred CI.pdf')
    expect(started.guide).toEqual({
      filename: 'Kindred CI.pdf',
      mime: 'application/pdf',
      sizeBytes: 9,
    })
    await expect(store.requireSession(started.sessionId)).resolves.toMatchObject({
      source: 'guide',
      url: null,
    })
    await expect(store.getGuide(started.sessionId)).resolves.toEqual({
      filename: 'Kindred CI.pdf',
      mime: 'application/pdf',
      sizeBytes: 9,
      base64: PDF_B64,
    })
    const round0 = await store.getRound(started.sessionId, 0)
    expect(round0).toMatchObject({ screenshotB64: '', candidates: [] })
    expect(round0!.digest).toContain('BRAND GUIDE: “Kindred CI.pdf”')
  })

  it('extract_guide_start refuses an unsupported file with a typed error and opens no session', async () => {
    const store = new InMemoryBrandExtractionStore()
    const createGuideSession = vi.spyOn(store, 'createGuideSession')
    const { registry, activations } = wiredRegistry({ store })
    await activations.set('brand', true)
    const gif = Buffer.from('GIF89a......').toString('base64')
    const err = await registry
      .execute('brand.extract_guide_start', { filename: 'anim.gif', dataB64: gif }, humanAdmin)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GuideUploadError)
    expect((err as GuideUploadError).code).toBe('unsupported_type')
    expect(createGuideSession).not.toHaveBeenCalled()
  })

  it('extract_guide_start refuses malformed base64 at the input schema', async () => {
    const { registry, activations } = wiredRegistry()
    await activations.set('brand', true)
    await expect(
      registry.execute(
        'brand.extract_guide_start',
        { filename: 'g.pdf', dataB64: 'not base64!' },
        humanAdmin,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('extract_guide_start is human-only (G8)', async () => {
    const { registry, activations } = wiredRegistry()
    await activations.set('brand', true)
    await expect(
      registry.execute(
        'brand.extract_guide_start',
        { filename: 'g.pdf', dataB64: PDF_B64 },
        agentPrincipal,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('propose on a guide session reads the guide (not a digest) and feeds back prior verdicts', async () => {
    const propose = fakePropose()
    const proposeGuide = fakePropose()
    const { store, registry, activations } = wiredRegistry({ propose, proposeGuide })
    await activations.set('brand', true)
    const started = (await registry.execute(
      'brand.extract_guide_start',
      { filename: 'board.png', dataB64: PNG_B64 },
      humanAdmin,
    )) as { sessionId: string }

    const first = (await registry.execute(
      'brand.extract_propose',
      { sessionId: started.sessionId },
      humanAdmin,
    )) as {
      round: number
    }
    expect(first.round).toBe(1)
    expect(propose).not.toHaveBeenCalled()
    expect(proposeGuide).toHaveBeenCalledWith({
      userId: 'owner-1',
      guide: { filename: 'board.png', mime: 'image/png', sizeBytes: 16, base64: PNG_B64 },
      priorRounds: [],
      aiSessionId: started.sessionId,
    })
    expect((await store.getRound(started.sessionId, 1))!.screenshotB64).toBe('')

    await registry.execute(
      'brand.extract_judge',
      { sessionId: started.sessionId, round: 1, chosen: null, note: 'warmer neutrals' },
      humanAdmin,
    )
    await registry.execute('brand.extract_propose', { sessionId: started.sessionId }, humanAdmin)
    const second = proposeGuide.mock.calls[1][0] as unknown as {
      priorRounds: Array<{ verdict: unknown }>
    }
    expect(second.priorRounds[0].verdict).toEqual({ chosen: null, note: 'warmer neutrals' })
  })

  it('the full loop runs for a guide: start -> propose -> judge -> accept stages a corpus item naming the guide', async () => {
    const { store, registry, activations } = wiredRegistry({ proposeGuide: fakePropose() })
    await activations.set('brand', true)
    const started = (await registry.execute(
      'brand.extract_guide_start',
      { filename: 'Kindred CI.pdf', dataB64: PDF_B64 },
      humanAdmin,
    )) as { sessionId: string }
    await registry.execute('brand.extract_propose', { sessionId: started.sessionId }, humanAdmin)
    await registry.execute(
      'brand.extract_judge',
      { sessionId: started.sessionId, round: 1, chosen: 0 },
      humanAdmin,
    )
    const accepted = (await registry.execute(
      'brand.extract_accept',
      { sessionId: started.sessionId, name: 'Kindred print' },
      humanAdmin,
    )) as { corpusItem: { provenance: Record<string, unknown> } }
    expect(accepted.corpusItem.provenance).toMatchObject({
      source: 'extraction',
      note: 'brand guide “Kindred CI.pdf”',
    })
    await expect(store.requireSession(started.sessionId)).resolves.toMatchObject({
      status: 'accepted',
    })
  })

  it('extract_session_get names the guide (no bytes) for a guide session, null for a URL session', async () => {
    const { store, registry, activations } = wiredRegistry()
    await activations.set('brand', true)
    const started = (await registry.execute(
      'brand.extract_guide_start',
      { filename: 'Kindred CI.pdf', dataB64: PDF_B64 },
      humanAdmin,
    )) as { sessionId: string }
    const guideRead = (await registry.execute(
      'brand.extract_session_get',
      { sessionId: started.sessionId },
      agentPrincipal,
    )) as { guide: unknown }
    expect(guideRead.guide).toEqual({
      filename: 'Kindred CI.pdf',
      mime: 'application/pdf',
      sizeBytes: 9,
    })
    const site = await sessionFixture(store)
    const siteRead = (await registry.execute(
      'brand.extract_session_get',
      { sessionId: site.id },
      agentPrincipal,
    )) as {
      guide: unknown
    }
    expect(siteRead.guide).toBeNull()
  })
})

async function sessionFixture(store: InMemoryBrandExtractionStore) {
  const session = await store.createSession({ url: 'https://example.com', title: 'Example' })
  await store.createRound({
    sessionId: session.id,
    round: 0,
    digest: 'SITE: Example',
    screenshotB64: 'c2hvdA==',
    candidates: [],
  })
  return session
}
