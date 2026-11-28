import { avatarShaFromUrl, presetIdFromAvatarUrl, type CoworkerAvatarPresetId } from './avatar-presets'

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
  /** Checked manager user ids (empty = answers to the owner). */
  reportsTo: string[]
  dailyCapUsd: string
  avatarPreset: CoworkerAvatarPresetId | null
  avatarSha256: string | null
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
  /** null on eigenInference (no model to name or pick). */
  modelId: string | null
  reportsToUserId: string | null
  reportsToUserIds?: string[]
  image?: string | null
  dailyCapUsd: number
}

export const emptyDraft = (): CardDraft => ({
  name: '',
  title: '',
  accountabilities: '',
  lens: '',
  modelId: '',
  reportsTo: [],
  dailyCapUsd: '',
  avatarPreset: null,
  avatarSha256: null,
})

/** A template's card; the name starts as its title (the person may rename it), reports-to and avatar are kept. */
export function draftFromTemplate(
  t: TemplateLike,
  keep: Pick<CardDraft, 'reportsTo' | 'avatarPreset' | 'avatarSha256'>,
): CardDraft {
  return {
    name: t.title,
    title: t.title,
    accountabilities: t.accountabilities.join('\n'),
    lens: t.lens,
    modelId: t.suggestedModelId,
    reportsTo: [...keep.reportsTo],
    dailyCapUsd: String(t.suggestedDailyCapUsd),
    avatarPreset: keep.avatarPreset,
    avatarSha256: keep.avatarSha256,
  }
}

export function draftFromCoworker(c: CoworkerLike): CardDraft {
  const reportsTo =
    c.reportsToUserIds && c.reportsToUserIds.length > 0
      ? [...c.reportsToUserIds]
      : c.reportsToUserId
        ? [c.reportsToUserId]
        : []
  return {
    name: c.name,
    title: c.title ?? '',
    accountabilities: c.accountabilities.join('\n'),
    lens: c.lens,
    modelId: c.modelId ?? '',
    reportsTo,
    dailyCapUsd: String(c.dailyCapUsd),
    avatarPreset: presetIdFromAvatarUrl(c.image),
    avatarSha256: avatarShaFromUrl(c.image),
  }
}
