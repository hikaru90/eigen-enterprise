import { describe, expect, it } from 'vitest'
import { deviceLabel, sessionPlace } from './session-label'

const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const WIN_FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'
const HEADLESS =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36'

describe('deviceLabel: a readable device from the user agent (parsed structurally)', () => {
  it.each([
    [MAC_CHROME, 'Chrome on macOS'],
    [IPHONE_SAFARI, 'Safari on iOS'],
    [WIN_FIREFOX, 'Firefox on Windows'],
    [HEADLESS, 'Chrome on Linux'],
  ])('%s → %s', (ua, label) => {
    expect(deviceLabel(ua)).toBe(label)
  })
  it('is null without a user agent', () => {
    expect(deviceLabel(null)).toBeNull()
    expect(deviceLabel('')).toBeNull()
  })
})

describe('sessionPlace: the second line of a session row', () => {
  it('shows the address when recorded', () => {
    expect(
      sessionPlace(
        { ipAddress: '203.0.113.7', createdAt: '2026-11-02T10:00:00.000Z' },
        () => '2 Nov',
      ),
    ).toBe('203.0.113.7')
  })
  it('says when it was signed in instead of "Unknown address"', () => {
    expect(
      sessionPlace({ ipAddress: null, createdAt: '2026-11-02T10:00:00.000Z' }, () => '2 Nov'),
    ).toBe('Signed in 2 Nov')
  })
})
