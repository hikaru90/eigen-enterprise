import type { ProposedCandidate } from './propose'
import { describe, expect, it } from 'vitest'
import { expandSeeds } from '../style-format/expand'
import { validSeeds } from '../style-format/seeds.spec'
import { InMemoryBrandExtractionStore } from './store'

const pdfGuide = {
  filename: 'Kindred CI.pdf',
  mime: 'application/pdf' as const,
  sizeBytes: 9,
  base64: 'JVBERi0xLjcK',
}

function candidate(): ProposedCandidate {
  const seeds = validSeeds()
  const expanded = expandSeeds(seeds)
  return { label: 'Color-led', seeds, cssVars: expanded.cssVars, darkCssVars: expanded.darkCssVars }
}

async function sessionWithJudgedRound(store: InMemoryBrandExtractionStore) {
  const session = await store.createSession({ url: 'https://example.com', title: 'Example' })
  await store.createRound({
    sessionId: session.id,
    round: 0,
    digest: 'SITE: Example',
    screenshotB64: 'c2hvdA==',
    candidates: [],
  })
  await store.createRound({
    sessionId: session.id,
    round: 1,
    digest: 'SITE: Example',
    screenshotB64: 'c2hvdA==',
    candidates: [candidate(), candidate(), candidate()],
  })
  return session
}

describe('InMemoryBrandExtractionStore', () => {
  it('creates active sessions and stores capture facts as round 0', async () => {
    const store = new InMemoryBrandExtractionStore()
    const session = await store.createSession({ url: 'https://example.com', title: 'Example' })
    expect(session.status).toBe('active')
    const rounds = await store.listRounds(session.id)
    expect(rounds).toHaveLength(0)
    await store.createRound({
      sessionId: session.id,
      round: 0,
      digest: 'SITE: Example',
      screenshotB64: 'c2hvdA==',
      candidates: [],
    })
    expect((await store.getRound(session.id, 0))!.screenshotB64).toBe('c2hvdA==')
  })

  it('fails loud on unknown sessions and duplicate round numbers', async () => {
    const store = new InMemoryBrandExtractionStore()
    await expect(
      store.createRound({
        sessionId: '0b8f8d9e-6a1e-4b3e-9c2f-1a2b3c4d5e6f',
        round: 0,
        digest: 'd',
        screenshotB64: 's',
        candidates: [],
      }),
    ).rejects.toThrow(/unknown brand extraction session/)
    const session = await store.createSession({ url: 'https://example.com', title: null })
    await store.createRound({
      sessionId: session.id,
      round: 0,
      digest: 'd',
      screenshotB64: 's',
      candidates: [],
    })
    await expect(
      store.createRound({
        sessionId: session.id,
        round: 0,
        digest: 'd',
        screenshotB64: 's',
        candidates: [],
      }),
    ).rejects.toThrow(/already exists/)
  })

  it('stores verdicts; chosen=null rejects the round', async () => {
    const store = new InMemoryBrandExtractionStore()
    const session = await sessionWithJudgedRound(store)
    const judged = await store.judgeRound({
      sessionId: session.id,
      round: 1,
      chosen: null,
      note: 'too corporate',
    })
    expect(judged.verdict).toEqual({ chosen: null, note: 'too corporate' })
    const chosen = await store.judgeRound({ sessionId: session.id, round: 1, chosen: 2 })
    expect(chosen.verdict).toEqual({ chosen: 2 })
  })

  it('rejects out-of-range verdicts', async () => {
    const store = new InMemoryBrandExtractionStore()
    const session = await sessionWithJudgedRound(store)
    await expect(store.judgeRound({ sessionId: session.id, round: 1, chosen: 3 })).rejects.toThrow(
      /out of range/,
    )
    await expect(store.judgeRound({ sessionId: session.id, round: 7, chosen: 0 })).rejects.toThrow(
      /unknown round 7/,
    )
  })

  it('accept stages a corpus item with extraction provenance and marks the session accepted', async () => {
    const store = new InMemoryBrandExtractionStore()
    const session = await sessionWithJudgedRound(store)
    await expect(store.accept(session.id, 'Kindred web')).rejects.toThrow(/no judged round/)
    await store.judgeRound({ sessionId: session.id, round: 1, chosen: 1 })
    const staged = await store.accept(session.id, 'Kindred web')
    expect(staged.status).toBe('staged')
    expect(staged.corpusItem.name).toBe('Kindred web')
    expect(staged.corpusItem.provenance.source).toBe('extraction')
    expect(staged.corpusItem.provenance.url).toBe('https://example.com')
    expect(staged.corpusItem.seeds).toEqual(validSeeds())
    expect(staged.corpusItem.cssVars['--background']).toMatch(/^oklch\(/)
    const after = await store.requireSession(session.id)
    expect(after.status).toBe('accepted')
    await expect(store.accept(session.id, 'Again')).rejects.toThrow(/only active sessions/)
  })

  it('accept fails loud when the latest chosen candidate is invalid', async () => {
    const store = new InMemoryBrandExtractionStore()
    const session = await store.createSession({ url: 'https://example.com', title: 'x' })
    await store.createRound({
      sessionId: session.id,
      round: 1,
      digest: 'd',
      screenshotB64: 's',
      candidates: [{ label: 'Color-led', error: 'bad json' }],
    })
    await store.judgeRound({ sessionId: session.id, round: 1, chosen: 0 })
    await expect(store.accept(session.id, 'x')).rejects.toThrow(/not an acceptable proposal/)
  })

  it('a URL session has source url; it keeps no guide', async () => {
    const store = new InMemoryBrandExtractionStore()
    const session = await store.createSession({ url: 'https://example.com', title: 'Example' })
    expect(session.source).toBe('url')
    expect(session.url).toBe('https://example.com')
    await expect(store.getGuide(session.id)).resolves.toBeNull()
    await expect(store.getGuideMeta(session.id)).resolves.toBeNull()
  })

  it('a guide session keeps the uploaded guide next to it; no URL, the file name as title', async () => {
    const store = new InMemoryBrandExtractionStore()
    const session = await store.createGuideSession({ guide: pdfGuide })
    expect(session).toMatchObject({
      source: 'guide',
      url: null,
      title: 'Kindred CI.pdf',
      status: 'active',
    })
    await expect(store.getGuide(session.id)).resolves.toEqual(pdfGuide)
    await expect(store.getGuideMeta(session.id)).resolves.toEqual({
      filename: 'Kindred CI.pdf',
      mime: 'application/pdf',
      sizeBytes: 9,
    })
  })

  it('refuses a guide outside the accepted formats at the store boundary', async () => {
    const store = new InMemoryBrandExtractionStore()
    await expect(
      store.createGuideSession({ guide: { ...pdfGuide, mime: 'image/gif' as never } }),
    ).rejects.toThrow()
  })

  it('rounds carry a screenshot only for URL sessions (a guide session has its guide instead)', async () => {
    const store = new InMemoryBrandExtractionStore()
    const site = await store.createSession({ url: 'https://example.com', title: null })
    await expect(
      store.createRound({
        sessionId: site.id,
        round: 0,
        digest: 'd',
        screenshotB64: '',
        candidates: [],
      }),
    ).rejects.toThrow(/needs the capture screenshot/)
    const guide = await store.createGuideSession({ guide: pdfGuide })
    await expect(
      store.createRound({
        sessionId: guide.id,
        round: 0,
        digest: 'd',
        screenshotB64: 'c2hvdA==',
        candidates: [],
      }),
    ).rejects.toThrow(/has no screenshot/)
    const round = await store.createRound({
      sessionId: guide.id,
      round: 0,
      digest: 'BRAND GUIDE',
      screenshotB64: '',
      candidates: [],
    })
    expect(round.screenshotB64).toBe('')
  })

  it('accepting from a guide session stages a corpus item whose provenance names the guide', async () => {
    const store = new InMemoryBrandExtractionStore()
    const session = await store.createGuideSession({ guide: pdfGuide })
    await store.createRound({
      sessionId: session.id,
      round: 0,
      digest: 'BRAND GUIDE',
      screenshotB64: '',
      candidates: [],
    })
    await store.createRound({
      sessionId: session.id,
      round: 1,
      digest: 'BRAND GUIDE',
      screenshotB64: '',
      candidates: [candidate(), candidate(), candidate()],
    })
    await store.judgeRound({ sessionId: session.id, round: 1, chosen: 0 })
    const staged = await store.accept(session.id, 'Kindred print')
    expect(staged.corpusItem.provenance).toEqual({
      source: 'extraction',
      capturedAt: session.createdAt,
      note: 'brand guide “Kindred CI.pdf”',
    })
    expect(staged.corpusItem.provenance.url).toBeUndefined()
  })

  it('listStaged + markExported drive the export path', async () => {
    const store = new InMemoryBrandExtractionStore()
    const session = await sessionWithJudgedRound(store)
    await store.judgeRound({ sessionId: session.id, round: 1, chosen: 0 })
    const staged = await store.accept(session.id, 'Kindred web')
    expect(await store.listStaged()).toHaveLength(1)
    const exported = await store.markExported(staged.id)
    expect(exported.status).toBe('exported')
    expect(await store.listStaged()).toHaveLength(0)
    await expect(store.markExported(staged.id)).rejects.toThrow(/already exported/)
  })
})
