import { describe, expect, it } from 'vitest'
import { resolveSocialMediaDir } from './social'

describe('resolveSocialMediaDir', () => {
  it('lives next to the Drive and refuses without storage configured', () => {
    expect(resolveSocialMediaDir({ DRIVE_STORAGE_DIR: '/srv/drive' })).toBe('/srv/drive/brand-social')
    expect(resolveSocialMediaDir({ EE_STATE_DIR: '/var/lib/ee' })).toBe('/var/lib/ee/drive/brand-social')
    expect(() => resolveSocialMediaDir({})).toThrow(/not configured/)
  })
})
