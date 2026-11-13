import { describe, expect, it } from 'vitest'
import { contributeHubEnv, OFFICIAL_CONTRIBUTE_HUB, parseContributeHubFlag, resolveContributeHub } from './contribute-hub.ts'
import { settingsSchema } from './company-repo.ts'

describe('the central Contribute board an install shares with (plan/contribute-phone-home.md §5)', () => {
  it('an existing company without the setting (an upgrade) gets the official board', () => {
    expect(settingsSchema.parse({ consoleHost: 'os.example.com' }).contributeHub).toBe(OFFICIAL_CONTRIBUTE_HUB)
    expect(OFFICIAL_CONTRIBUTE_HUB).toBe('https://os.cerberusblue.com')
  })

  it('an explicit flag wins and is saved; a plain re-run keeps what is saved', () => {
    expect(resolveContributeHub('off', OFFICIAL_CONTRIBUTE_HUB)).toBe('off')
    expect(resolveContributeHub(undefined, 'off')).toBe('off')
    expect(resolveContributeHub('https://hub.example.org', 'off')).toBe('https://hub.example.org')
  })

  it('the flag is an https origin or "off"; anything else stops the install, saying what to pass', () => {
    expect(parseContributeHubFlag('off')).toBe('off')
    expect(parseContributeHubFlag('https://hub.example.org')).toBe('https://hub.example.org')
    expect(() => parseContributeHubFlag('hub.example.org')).toThrow(/--contribute-hub/)
    expect(() => parseContributeHubFlag('http://hub.example.org')).toThrow(/https/)
    expect(() => parseContributeHubFlag('https://hub.example.org/api')).toThrow(/origin/)
  })

  it('env: the URL when set; off removes a URL an earlier run wrote', () => {
    expect(contributeHubEnv({ ORIGIN: 'https://os.example.com' }, OFFICIAL_CONTRIBUTE_HUB)).toEqual({
      ORIGIN: 'https://os.example.com',
      CONTRIBUTE_HUB_URL: OFFICIAL_CONTRIBUTE_HUB,
    })
    expect(contributeHubEnv({ ORIGIN: 'https://os.example.com', CONTRIBUTE_HUB_URL: OFFICIAL_CONTRIBUTE_HUB }, 'off')).toEqual({
      ORIGIN: 'https://os.example.com',
    })
  })
})
