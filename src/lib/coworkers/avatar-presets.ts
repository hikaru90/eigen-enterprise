import { AVATAR_ROUTE, isAvatarSha } from '$lib/profile/profile'

/**
 * Abstract eigenEnterprise CI avatars for AI co-workers (contribution 8cdc80d8).
 * Static SVGs live under static/avatars/coworkers/<id>.svg and use only the
 * brand CI palette: an ink/paper stage (#111111, #F7F5F0) and exactly one small
 * accent (#FF4632, #A3D8F4, #B8E9D0, #FFC107 or #FE86B1).
 */

export const COWORKER_AVATAR_PRESET_IDS = [
  'prism',
  'orbit',
  'blocks',
  'arch',
  'signal',
  'mosaic',
  'beacon',
  'ribbon',
] as const

export type CoworkerAvatarPresetId = (typeof COWORKER_AVATAR_PRESET_IDS)[number]

export type CoworkerAvatarPreset = {
  id: CoworkerAvatarPresetId
  label: string
  url: string
}

export const COWORKER_AVATAR_PRESET_BASE = '/avatars/coworkers'

export function coworkerAvatarPresetUrl(id: CoworkerAvatarPresetId): string {
  return `${COWORKER_AVATAR_PRESET_BASE}/${id}.svg`
}

const LABELS: Record<CoworkerAvatarPresetId, string> = {
  prism: 'Prism',
  orbit: 'Orbit',
  blocks: 'Blocks',
  arch: 'Arch',
  signal: 'Signal',
  mosaic: 'Mosaic',
  beacon: 'Beacon',
  ribbon: 'Ribbon',
}

export const COWORKER_AVATAR_PRESETS: readonly CoworkerAvatarPreset[] = COWORKER_AVATAR_PRESET_IDS.map((id) => ({
  id,
  label: LABELS[id],
  url: coworkerAvatarPresetUrl(id),
}))

const PRESET_SET = new Set<string>(COWORKER_AVATAR_PRESET_IDS)
const PRESET_URL_TO_ID = new Map<string, CoworkerAvatarPresetId>(COWORKER_AVATAR_PRESETS.map((p) => [p.url, p.id]))

export function isCoworkerAvatarPresetId(value: unknown): value is CoworkerAvatarPresetId {
  return typeof value === 'string' && PRESET_SET.has(value)
}

export function isCoworkerAvatarPresetUrl(value: unknown): value is string {
  return typeof value === 'string' && PRESET_URL_TO_ID.has(value)
}

export function presetIdFromAvatarUrl(url: string | null | undefined): CoworkerAvatarPresetId | null {
  if (!url) return null
  return PRESET_URL_TO_ID.get(url) ?? null
}

const AVATAR_PREFIX = `${AVATAR_ROUTE}/`

export function avatarShaFromUrl(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(AVATAR_PREFIX)) return null
  const sha = url.slice(AVATAR_PREFIX.length)
  return isAvatarSha(sha) ? sha : null
}
