import { describe, expect, it, vi } from 'vitest'
import { InMemoryBrandStore, createSetInputSchema } from './store'

/** Valid CARE-complete context for guard tests. */
function validContext() {
  return {
    mission: 'Make AI-native company operations legible.',
    audience: 'Founder-operators of small companies.',
    register: 'Plain, direct, no hype.',
    toneAttributes: ['clear and approachable', 'action-oriented and candid'],
  }
}

async function activatedSet(store: InMemoryBrandStore, locale = 'en') {
  const set = await store.createSet({ locale, context: validContext() })
  await store.addVoiceExample({
    setId: set.id,
    contentType: 'headline',
    body: 'Ship your company OS today',
    label: 'good',
    rationale: 'Names the outcome, no superlatives',
  })
  await store.addVoiceExample({
    setId: set.id,
    contentType: 'headline',
    body: 'Revolutionary AI-powered synergy disruption!!!',
    label: 'bad',
    rationale: 'Superlatives + hype',
  })
  const activated = await store.activateSet(set.id)
  return { set, activated }
}

describe('InMemoryBrandStore — set lifecycle', () => {
  it('creates draft sets with per-locale version increments', async () => {
    const store = new InMemoryBrandStore()
    const en1 = await store.createSet({ locale: 'en', context: validContext() })
    const en2 = await store.createSet({ locale: 'en', context: validContext() })
    const de = await store.createSet({ locale: 'de-DE', context: validContext() })
    expect(en1.status).toBe('draft')
    expect(en1.version).toBe(1)
    expect(en2.version).toBe(2)
    expect(de.version).toBe(1)
  })

  it('rejects a single tone word at schema level (G2)', () => {
    expect(
      createSetInputSchema.safeParse({
        locale: 'en',
        context: { ...validContext(), toneAttributes: ['happy'] },
      }).success,
    ).toBe(false)
    expect(
      createSetInputSchema.safeParse({
        locale: 'en',
        context: { ...validContext(), toneAttributes: ['clear'] },
      }).success,
    ).toBe(false)
  })

  it('requires at least two tone descriptors (G2)', () => {
    expect(
      createSetInputSchema.safeParse({
        locale: 'en',
        context: { ...validContext(), toneAttributes: ['clear and approachable'] },
      }).success,
    ).toBe(false)
  })

  it('rejects malformed locales at schema level (D3, syntax only)', () => {
    expect(createSetInputSchema.safeParse({ locale: 'x', context: validContext() }).success).toBe(
      false,
    )
    expect(
      createSetInputSchema.safeParse({ locale: 'en-US', context: validContext() }).success,
    ).toBe(true)
  })

  it('activation requires exemplar-first voice: >=2 examples, >=1 good and >=1 bad (G2)', async () => {
    const store = new InMemoryBrandStore()
    const none = await store.createSet({ locale: 'en', context: validContext() })
    await expect(store.activateSet(none.id)).rejects.toThrow(/exemplar-first/)

    const onlyGood = await store.createSet({ locale: 'en', context: validContext() })
    await store.addVoiceExample({
      setId: onlyGood.id,
      contentType: 'headline',
      body: 'Ship your company OS today',
      label: 'good',
    })
    await expect(store.activateSet(onlyGood.id)).rejects.toThrow(/1 good \/ 0 bad/)

    const balanced = await store.createSet({ locale: 'en', context: validContext() })
    await store.addVoiceExample({
      setId: balanced.id,
      contentType: 'headline',
      body: 'good',
      label: 'good',
    })
    await store.addVoiceExample({
      setId: balanced.id,
      contentType: 'headline',
      body: 'bad',
      label: 'bad',
    })
    const activated = await store.activateSet(balanced.id)
    expect(activated.status).toBe('active')
    expect(activated.activatedAt).not.toBeNull()
  })

  it('activation requires CARE-complete context (mission, audience, register) (G1)', async () => {
    const store = new InMemoryBrandStore()
    const set = await store.createSet({
      locale: 'en',
      context: { toneAttributes: ['clear and approachable', 'candid and direct'] },
    })
    await expect(store.activateSet(set.id)).rejects.toThrow(/context\.mission/)
  })

  it('enforces one active set per locale (D3) — loud, not implicit-latest (G23)', async () => {
    const store = new InMemoryBrandStore()
    await activatedSet(store, 'en')
    const second = await store.createSet({ locale: 'en', context: validContext() })
    await store.addVoiceExample({
      setId: second.id,
      contentType: 'headline',
      body: 'good',
      label: 'good',
    })
    await store.addVoiceExample({
      setId: second.id,
      contentType: 'headline',
      body: 'bad',
      label: 'bad',
    })
    await expect(store.activateSet(second.id)).rejects.toThrow(/one active set per locale/)

    // A different locale activates fine.
    const { activated } = await activatedSet(store, 'de-DE')
    expect(activated.status).toBe('active')
  })

  it('active/retired sets are immutable (G23): no context patch, no curation writes', async () => {
    const store = new InMemoryBrandStore()
    const { set } = await activatedSet(store)
    await expect(
      store.updateDraftSet({ setId: set.id, context: { mission: 'New mission' } }),
    ).rejects.toThrow(/immutable/)
    await expect(
      store.addVoiceExample({ setId: set.id, contentType: 'h', body: 'x', label: 'good' }),
    ).rejects.toThrow(/draft sets/)
    await expect(
      store.addLexiconEntry({ setId: set.id, term: 'synergy', kind: 'banned' }),
    ).rejects.toThrow(/draft sets/)
  })

  it('getActiveSet resolves by explicit locale and fails loud without one (G23)', async () => {
    const store = new InMemoryBrandStore()
    await expect(store.getActiveSet('en')).rejects.toThrow(/no active brand guideline set/)
    const { activated } = await activatedSet(store, 'en')
    await expect(store.getActiveSet('en')).resolves.toMatchObject({ id: activated.id })
  })

  it('rejects duplicate lexicon terms, criteria, tokens, and glossary entries per set', async () => {
    const store = new InMemoryBrandStore()
    const set = await store.createSet({ locale: 'en', context: validContext() })
    await store.addLexiconEntry({ setId: set.id, term: 'synergy', kind: 'banned' })
    await expect(
      store.addLexiconEntry({ setId: set.id, term: 'synergy', kind: 'banned' }),
    ).rejects.toThrow(/duplicate lexicon term/)
    await store.addCriterion({
      setId: set.id,
      contentType: 'headline',
      criterion: 'max_seven_words',
      kind: 'deterministic',
      spec: { maxWords: 7 },
      riskTier: 'standard',
    })
    await expect(
      store.addCriterion({
        setId: set.id,
        contentType: 'headline',
        criterion: 'max_seven_words',
        kind: 'deterministic',
        spec: { maxWords: 7 },
        riskTier: 'standard',
      }),
    ).rejects.toThrow(/duplicate criterion/)
    await store.addVisualToken({ setId: set.id, token: 'color.accent', value: '#000000' })
    await expect(
      store.addVisualToken({ setId: set.id, token: 'color.accent', value: '#111111' }),
    ).rejects.toThrow(/duplicate visual token/)
    await store.addGlossaryEntry({ setId: set.id, term: 'company OS', definition: 'The product.' })
    await expect(
      store.addGlossaryEntry({ setId: set.id, term: 'company OS', definition: 'Again.' }),
    ).rejects.toThrow(/duplicate glossary term/)
  })

  it('lists sets filtered by status and locale; lists children per set', async () => {
    const store = new InMemoryBrandStore()
    const { set } = await activatedSet(store, 'en')
    await store.createSet({ locale: 'en', context: validContext() })
    const drafts = await store.listSets({ status: 'draft' })
    expect(drafts).toHaveLength(1)
    const en = await store.listSets({ locale: 'en' })
    expect(en).toHaveLength(2)
    const examples = await store.listVoiceExamples(set.id)
    expect(examples.map((e) => e.label).sort()).toEqual(['bad', 'good'])
    await expect(store.listCriteria(set.id)).resolves.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Visual sets (phase-2d M4): draft-only writes, one active set per company.
// ---------------------------------------------------------------------------

const ITEM_A = '1a000000-0000-4000-8000-00000000000a'
const ITEM_B = '1b000000-0000-4000-8000-00000000000b'
const ITEM_C = '1c000000-0000-4000-8000-00000000000c'

function visualSetInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Kindred draft',
    pickedItemIds: [ITEM_A, ITEM_B, ITEM_C],
    cssVars: { '--background': '#ffffff', '--primary': '#333333' },
    ...overrides,
  }
}

describe('InMemoryBrandStore — visual sets (phase-2d M4)', () => {
  it('creates a draft visual set with the selection trail and resolved tokens', async () => {
    const store = new InMemoryBrandStore()
    const set = await store.createVisualSet(
      visualSetInput({ sourceItemId: ITEM_A, darkCssVars: { '--background': '#111111' } }),
    )
    expect(set.status).toBe('draft')
    expect(set.sourceItemId).toBe(ITEM_A)
    expect(set.pickedItemIds).toEqual([ITEM_A, ITEM_B, ITEM_C])
    expect(set.cssVars['--primary']).toBe('#333333')
    expect(set.darkCssVars).toEqual({ '--background': '#111111' })
    expect(set.seeds).toBeNull()
  })

  it('fails loud on empty cssVars, empty picks, or duplicate picks', async () => {
    const store = new InMemoryBrandStore()
    await expect(store.createVisualSet(visualSetInput({ cssVars: {} }))).rejects.toThrow(/cssVars must not be empty/)
    await expect(store.createVisualSet(visualSetInput({ pickedItemIds: [] }))).rejects.toThrow(/at least one picked corpus item/)
    await expect(
      store.createVisualSet(visualSetInput({ pickedItemIds: [ITEM_A, ITEM_A, ITEM_B] })),
    ).rejects.toThrow(/duplicates/)
  })

  it('updates draft sets: patch replaces provided fields and keeps the rest', async () => {
    const store = new InMemoryBrandStore()
    const set = await store.createVisualSet(visualSetInput())
    const updated = await store.updateVisualSet({
      setId: set.id,
      name: 'Renamed draft',
      pickedItemIds: [ITEM_B, ITEM_C, ITEM_A],
    })
    expect(updated.name).toBe('Renamed draft')
    expect(updated.pickedItemIds).toEqual([ITEM_B, ITEM_C, ITEM_A])
    expect(updated.cssVars).toEqual(set.cssVars)
    expect(updated.updatedAt >= set.updatedAt).toBe(true)
  })

  it('active/retired visual sets are immutable (G23): no update after activation', async () => {
    const store = new InMemoryBrandStore()
    const set = await store.createVisualSet(visualSetInput())
    await store.activateVisualSet(set.id)
    await expect(
      store.updateVisualSet({ setId: set.id, name: 'Nope' }),
    ).rejects.toThrow(/only allowed on draft sets/)
  })

  it('activation is the one-active-per-company flip; a second active set fails loud', async () => {
    const store = new InMemoryBrandStore()
    await expect(store.getActiveVisualSet()).rejects.toThrow(/no active brand visual set/)
    const first = await store.createVisualSet(visualSetInput())
    const activated = await store.activateVisualSet(first.id)
    expect(activated.status).toBe('active')
    await expect(store.getActiveVisualSet()).resolves.toMatchObject({ id: first.id })

    const second = await store.createVisualSet(visualSetInput({ name: 'Second draft' }))
    await expect(store.activateVisualSet(second.id)).rejects.toThrow(/one active set per company/)
  })

  it('get and list resolve sets; unknown ids read null; list is newest-first', async () => {
    const store = new InMemoryBrandStore()
    const set = await store.createVisualSet(visualSetInput())
    await expect(store.getVisualSet(set.id)).resolves.toMatchObject({ id: set.id })
    await expect(store.getVisualSet('2a000000-0000-4000-8000-00000000000a')).resolves.toBeNull()

    vi.useFakeTimers({ now: new Date(Date.now() + 5_000) })
    try {
      await store.createVisualSet(visualSetInput({ name: 'Newer draft' }))
    } finally {
      vi.useRealTimers()
    }
    const all = await store.listVisualSets()
    expect(all.map((s) => s.name)).toEqual(['Newer draft', 'Kindred draft'])
  })
})
