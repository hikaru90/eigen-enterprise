import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COWORKER_AVATAR_PRESET_IDS,
  COWORKER_AVATAR_PRESETS,
  avatarShaFromUrl,
  coworkerAvatarPresetUrl,
  isCoworkerAvatarPresetId,
  isCoworkerAvatarPresetUrl,
  presetIdFromAvatarUrl,
} from './avatar-presets'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const CI_HEX = new Set(['#111111', '#FF4632', '#A3D8F4', '#B8E9D0', '#FFC107', '#FE86B1', '#F7F5F0'])

describe('coworker abstract CI avatar presets', () => {
  it('declares all 8 presets with static SVG files in the eigenEnterprise CI palette, one accent each', () => {
    expect(COWORKER_AVATAR_PRESETS).toHaveLength(8)
    expect(COWORKER_AVATAR_PRESETS.map((p) => p.id)).toEqual([...COWORKER_AVATAR_PRESET_IDS])

    for (const preset of COWORKER_AVATAR_PRESETS) {
      expect(preset.url).toBe(`/avatars/coworkers/${preset.id}.svg`)
      const svgPath = path.join(ROOT, 'static', 'avatars', 'coworkers', `${preset.id}.svg`)
      const svg = readFileSync(svgPath, 'utf8')
      expect(svg).toContain('<svg')
      expect(svg).toContain('viewBox="0 0 256 256"')
      expect(svg.toLowerCase()).not.toContain('<script')
      const hexes = svg.match(/#[0-9A-Fa-f]{6}/g) ?? []
      expect(hexes.length).toBeGreaterThan(1)
      for (const hex of hexes) {
        expect(CI_HEX.has(hex.toUpperCase()), `${preset.id}.svg uses non-CI color ${hex}`).toBe(true)
      }
      // Restrained: a neutral stage (ink + paper) with one small accent, never a stack of brights.
      const accents = new Set(hexes.map((h) => h.toUpperCase()).filter((h) => h !== '#111111' && h !== '#F7F5F0'))
      expect(accents.size, `${preset.id}.svg uses ${accents.size} accent colors`).toBe(1)
    }
  })

  it('validates and round-trips preset ids, preset URLs, and uploaded avatar SHAs', () => {
    expect(isCoworkerAvatarPresetId('prism')).toBe(true)
    expect(isCoworkerAvatarPresetId('unknown')).toBe(false)
    expect(isCoworkerAvatarPresetId(null)).toBe(false)

    const url = coworkerAvatarPresetUrl('orbit')
    expect(url).toBe('/avatars/coworkers/orbit.svg')
    expect(isCoworkerAvatarPresetUrl(url)).toBe(true)
    expect(isCoworkerAvatarPresetUrl('/avatars/coworkers/nope.svg')).toBe(false)
    expect(isCoworkerAvatarPresetUrl('https://evil.example/orbit.svg')).toBe(false)

    expect(presetIdFromAvatarUrl(url)).toBe('orbit')
    expect(presetIdFromAvatarUrl('/avatars/coworkers/unknown.svg')).toBeNull()
    expect(presetIdFromAvatarUrl(null)).toBeNull()

    const sha = 'a'.repeat(64)
    expect(avatarShaFromUrl(`/api/people/avatar/${sha}`)).toBe(sha)
    expect(avatarShaFromUrl(url)).toBeNull()
    expect(avatarShaFromUrl('/api/people/avatar/not-a-sha')).toBeNull()
    expect(avatarShaFromUrl(null)).toBeNull()
  })
})
