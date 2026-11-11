import { describe, expect, it } from 'vitest'
import { detectBrowser, installGuide, type InstallEnvironment } from './install-prompt'

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  iphoneFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15',
  // iPadOS Safari asks for the desktop site: it reads as a Mac, told apart by touch.
  ipadSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  winEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
}

const env = (over: Partial<InstallEnvironment> = {}): InstallEnvironment => ({
  standalone: false,
  secureContext: true,
  nativePrompt: false,
  installedThisSession: false,
  userAgent: UA.macChrome,
  maxTouchPoints: 0,
  ...over,
})

describe('detectBrowser', () => {
  it('tells the platforms apart, iPad included', () => {
    expect(detectBrowser(UA.iphoneSafari, 5)).toEqual({ platform: 'ios', browser: 'safari' })
    expect(detectBrowser(UA.iphoneChrome, 5)).toEqual({ platform: 'ios', browser: 'chrome' })
    expect(detectBrowser(UA.iphoneFirefox, 5)).toEqual({ platform: 'ios', browser: 'firefox' })
    expect(detectBrowser(UA.ipadSafari, 5)).toEqual({ platform: 'ios', browser: 'safari' })
    expect(detectBrowser(UA.macSafari, 0)).toEqual({ platform: 'desktop', browser: 'safari' })
    expect(detectBrowser(UA.macChrome, 0)).toEqual({ platform: 'desktop', browser: 'chrome' })
    expect(detectBrowser(UA.winEdge, 0)).toEqual({ platform: 'desktop', browser: 'edge' })
    expect(detectBrowser(UA.winFirefox, 0)).toEqual({ platform: 'desktop', browser: 'firefox' })
    expect(detectBrowser(UA.androidChrome, 5)).toEqual({ platform: 'android', browser: 'chrome' })
    expect(detectBrowser(UA.androidSamsung, 5)).toEqual({ platform: 'android', browser: 'samsung' })
    expect(detectBrowser(UA.androidFirefox, 5)).toEqual({ platform: 'android', browser: 'firefox' })
  })
})

describe('installGuide', () => {
  it('is installed when running as the app', () => {
    expect(installGuide(env({ standalone: true })).kind).toBe('installed')
  })

  it('is just-installed after the browser reports the install', () => {
    expect(installGuide(env({ installedThisSession: true })).kind).toBe('just-installed')
  })

  it('cannot install off a secure origin, whatever the browser', () => {
    expect(installGuide(env({ secureContext: false, nativePrompt: true })).kind).toBe('insecure')
  })

  it('uses the browser’s own install dialog whenever it offered one', () => {
    expect(installGuide(env({ nativePrompt: true })).kind).toBe('native')
    expect(installGuide(env({ nativePrompt: true, userAgent: UA.androidChrome })).kind).toBe('native')
  })

  it('walks iPhone Safari through Share → Add to Home Screen', () => {
    const g = installGuide(env({ userAgent: UA.iphoneSafari, maxTouchPoints: 5 }))
    expect(g.kind).toBe('steps')
    if (g.kind !== 'steps') return
    expect(g.steps.join(' ')).toMatch(/Share/)
    expect(g.steps.join(' ')).toMatch(/Add to Home Screen/)
  })

  it('walks iPad Safari the same way, not as a Mac', () => {
    const g = installGuide(env({ userAgent: UA.ipadSafari, maxTouchPoints: 5 }))
    expect(g.kind === 'steps' && g.steps.join(' ')).toMatch(/Add to Home Screen/)
  })

  it('gives other iPhone browsers their own Share path', () => {
    const chrome = installGuide(env({ userAgent: UA.iphoneChrome, maxTouchPoints: 5 }))
    expect(chrome.kind === 'steps' && chrome.steps.join(' ')).toMatch(/Add to Home Screen/)
    const firefox = installGuide(env({ userAgent: UA.iphoneFirefox, maxTouchPoints: 5 }))
    expect(firefox.kind === 'steps' && firefox.steps.join(' ')).toMatch(/Add to Home Screen/)
  })

  it('walks Mac Safari through Add to Dock', () => {
    const g = installGuide(env({ userAgent: UA.macSafari }))
    expect(g.kind === 'steps' && g.steps.join(' ')).toMatch(/Add to Dock/)
  })

  it('falls back to the menu path in Chromium when no dialog was offered', () => {
    const chrome = installGuide(env({ userAgent: UA.macChrome }))
    expect(chrome.kind === 'steps' && chrome.steps.join(' ')).toMatch(/Install/)
    const edge = installGuide(env({ userAgent: UA.winEdge }))
    expect(edge.kind === 'steps' && edge.steps.join(' ')).toMatch(/Install this site as an app/)
    const android = installGuide(env({ userAgent: UA.androidChrome, maxTouchPoints: 5 }))
    expect(android.kind === 'steps' && android.steps.join(' ')).toMatch(/Add to Home screen/)
    const samsung = installGuide(env({ userAgent: UA.androidSamsung, maxTouchPoints: 5 }))
    expect(samsung.kind === 'steps' && samsung.steps.join(' ')).toMatch(/Home screen/)
    const firefox = installGuide(env({ userAgent: UA.androidFirefox, maxTouchPoints: 5 }))
    expect(firefox.kind === 'steps' && firefox.steps.join(' ')).toMatch(/Install|Home screen/)
  })

  it('says plainly that desktop Firefox cannot install apps, and where to go instead', () => {
    const g = installGuide(env({ userAgent: UA.winFirefox }))
    expect(g.kind).toBe('unsupported')
    if (g.kind !== 'unsupported') return
    expect(g.message).toMatch(/Chrome|Edge/)
  })
})
