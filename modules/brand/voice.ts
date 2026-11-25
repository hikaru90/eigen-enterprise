import type { BrandStore } from './store'

/**
 * The company's active brand voice as writing context for the AI (social
 * captions, material texts): the active guideline set's context, its
 * good/bad voice examples, lexicon and glossary.
 */

export type VoiceSource = Pick<BrandStore, 'listSets' | 'listVoiceExamples' | 'listLexicon' | 'listGlossary'>

export type BrandVoice = {
  locale: string
  context: Record<string, unknown>
  examples: Array<{ label: 'good' | 'bad'; body: string; contentType: string; rationale: string | null }>
  lexicon: Array<{ term: string; kind: string; replacement: string | null }>
  glossary: Array<{ term: string; definition: string; usageNote: string | null }>
}

/**
 * The active voice to write in: the asked locale, else the only active one;
 * null when none is active. An asked locale without an active voice, or
 * several active voices and no locale, fail loud through `refuse` (the
 * caller's own error type). `what` names what is being written ("captions").
 */
export async function resolveBrandVoice(
  brand: VoiceSource,
  locale: string | undefined,
  refuse: (message: string) => Error,
  what: string,
): Promise<BrandVoice | null> {
  const active = await brand.listSets({ status: 'active', ...(locale === undefined ? {} : { locale }) })
  if (locale !== undefined && active.length === 0) throw refuse(`No brand voice is active for ${locale}.`)
  if (active.length === 0) return null
  if (active.length > 1) {
    const locales = active.map((s) => s.locale).sort()
    throw refuse(`Several brand voices are active (${locales.join(', ')}): say which language the ${what} are for.`)
  }
  const set = active[0]
  const [examples, lexicon, glossary] = await Promise.all([
    brand.listVoiceExamples(set.id),
    brand.listLexicon(set.id),
    brand.listGlossary(set.id),
  ])
  return {
    locale: set.locale,
    context: set.context as Record<string, unknown>,
    examples: examples.map((e) => ({ label: e.label, body: e.body, contentType: e.contentType, rationale: e.rationale })),
    lexicon: lexicon.map((l) => ({ term: l.term, kind: l.kind, replacement: l.replacement })),
    glossary: glossary.map((g) => ({ term: g.term, definition: g.definition, usageNote: g.usageNote })),
  }
}
