/**
 * The role card as the Settings → Co-workers forms edit it
 * (plan/phase-ai-coworkers.md C5): what a template prefills and what an
 * existing co-worker starts from. Pure.
 */

export type CardDraft = {
  name: string
  title: string
  /** One accountability per line. */
  accountabilities: string
  lens: string
  modelId: string
  /** '' = reports to nobody (answers to the owner). */
  reportsTo: string
  dailyCapUsd: string
}

export type TemplateLike = {
  id: string
  title: string
  accountabilities: string[]
  lens: string
  suggestedModelId: string
  suggestedDailyCapUsd: number
}

export type CoworkerLike = {
  name: string
  title: string | null
  accountabilities: string[]
  lens: string
  modelId: string
  reportsToUserId: string | null
  dailyCapUsd: number
}

export const emptyDraft = (): CardDraft => ({
  name: '',
  title: '',
  accountabilities: '',
  lens: '',
  modelId: '',
  reportsTo: '',
  dailyCapUsd: '',
})

/** A template's card; the name starts as its title (the person may rename it), reports-to is kept. */
export function draftFromTemplate(t: TemplateLike, keep: Pick<CardDraft, 'reportsTo'>): CardDraft {
  return {
    name: t.title,
    title: t.title,
    accountabilities: t.accountabilities.join('\n'),
    lens: t.lens,
    modelId: t.suggestedModelId,
    reportsTo: keep.reportsTo,
    dailyCapUsd: String(t.suggestedDailyCapUsd),
  }
}

export function draftFromCoworker(c: CoworkerLike): CardDraft {
  return {
    name: c.name,
    title: c.title ?? '',
    accountabilities: c.accountabilities.join('\n'),
    lens: c.lens,
    modelId: c.modelId,
    reportsTo: c.reportsToUserId ?? '',
    dailyCapUsd: String(c.dailyCapUsd),
  }
}
