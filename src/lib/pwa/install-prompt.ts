/**
 * How to install eigenEnterprise as an app on this device — the "Install app"
 * entry in the settings menu (src/lib/pwa/install-app-dialog.svelte).
 *
 * Only Chromium browsers offer a dialog a page can open (beforeinstallprompt,
 * captured in src/app.html before the app boots). Everywhere else installing
 * is a browser menu action, so the guide names the exact taps for this
 * browser. Telling browsers apart needs the user agent: Safari, iOS and the
 * Android browsers expose no feature that says which install menu they have.
 * This is platform detection for instructions only, never meaning.
 *
 * - installed: running as the installed app already
 * - just-installed: the browser reported the install in this tab
 * - insecure: not https — no browser installs from here
 * - native: the browser's own install dialog is ready
 * - steps: the menu path for this browser
 * - unsupported: this browser cannot install web apps; which ones can
 */

export type InstallPlatform = 'ios' | 'android' | 'desktop'
export type InstallBrowser = 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'other'

export type InstallEnvironment = {
  /** Running as the installed app (display-mode standalone / iOS navigator.standalone). */
  standalone: boolean
  secureContext: boolean
  /** A captured beforeinstallprompt is waiting to be shown. */
  nativePrompt: boolean
  /** appinstalled fired in this tab. */
  installedThisSession: boolean
  userAgent: string
  maxTouchPoints: number
}

export type InstallGuide =
  | { kind: 'installed' }
  | { kind: 'just-installed' }
  | { kind: 'insecure' }
  | { kind: 'native' }
  | { kind: 'steps'; steps: string[]; note?: string }
  | { kind: 'unsupported'; message: string }

export function detectBrowser(
  userAgent: string,
  maxTouchPoints: number,
): { platform: InstallPlatform; browser: InstallBrowser } {
  const ua = userAgent
  // iPadOS Safari reports itself as a Mac; a Mac has no multi-touch screen.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
  if (ios) {
    if (/CriOS\//.test(ua)) return { platform: 'ios', browser: 'chrome' }
    if (/FxiOS\//.test(ua)) return { platform: 'ios', browser: 'firefox' }
    if (/EdgiOS\//.test(ua)) return { platform: 'ios', browser: 'edge' }
    return { platform: 'ios', browser: 'safari' }
  }
  const platform: InstallPlatform = /Android/.test(ua) ? 'android' : 'desktop'
  if (/SamsungBrowser\//.test(ua)) return { platform, browser: 'samsung' }
  if (/Firefox\//.test(ua)) return { platform, browser: 'firefox' }
  if (/Edg(A)?\//.test(ua)) return { platform, browser: 'edge' }
  if (/Chrome\/|Chromium\//.test(ua)) return { platform, browser: 'chrome' }
  if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return { platform, browser: 'safari' }
  return { platform, browser: 'other' }
}

const OPEN_FROM_HOME = 'Open it from your home screen — it starts full-screen, like any app.'
const ALREADY_INSTALLED_CHROMIUM =
  'If the menu says “Open in …” instead, it is already installed — open it from there.'

export function installGuide(env: InstallEnvironment): InstallGuide {
  if (env.standalone) return { kind: 'installed' }
  if (env.installedThisSession) return { kind: 'just-installed' }
  if (!env.secureContext) return { kind: 'insecure' }
  if (env.nativePrompt) return { kind: 'native' }

  const { platform, browser } = detectBrowser(env.userAgent, env.maxTouchPoints)

  if (platform === 'ios') {
    const finish = ['Leave “Open as Web App” on and tap Add.', OPEN_FROM_HOME]
    switch (browser) {
      case 'safari':
        return {
          kind: 'steps',
          steps: [
            'Tap the Share button — the square with an arrow (on iOS 26 it sits behind the ••• button next to the address).',
            'Scroll down and tap “Add to Home Screen”.',
            ...finish,
          ],
          note: 'No “Add to Home Screen”? You are in a browser inside another app — open this page in Safari first.',
        }
      case 'chrome':
        return {
          kind: 'steps',
          steps: ['Tap the Share button in the address bar (top right).', 'Tap “Add to Home Screen”.', ...finish],
        }
      case 'firefox':
      case 'edge':
        return {
          kind: 'steps',
          steps: ['Open the browser menu (☰) and tap Share.', 'Tap “Add to Home Screen”.', ...finish],
        }
      default:
        return {
          kind: 'steps',
          steps: ['Open this page in Safari.', 'Tap Share, then “Add to Home Screen”.', ...finish],
        }
    }
  }

  if (platform === 'android') {
    const done = 'Open it from your home screen or app list.'
    switch (browser) {
      case 'chrome':
        return {
          kind: 'steps',
          steps: ['Tap the ⋮ menu (top right).', 'Tap “Add to Home screen”, then “Install”.', done],
          note: ALREADY_INSTALLED_CHROMIUM,
        }
      case 'edge':
        return {
          kind: 'steps',
          steps: ['Tap the ••• menu (bottom).', 'Tap “Add to phone”, then “Install”.', done],
        }
      case 'samsung':
        return {
          kind: 'steps',
          steps: ['Tap the ≡ menu (bottom right).', 'Tap “Add page to”, then “Home screen”.', 'Tap Add.', done],
        }
      case 'firefox':
        return {
          kind: 'steps',
          steps: ['Tap the ⋮ menu.', 'Tap “Add app to Home screen” (or “Install”).', 'Tap Add.', done],
        }
      default:
        return {
          kind: 'unsupported',
          message: 'This browser cannot install apps. Open this page in Chrome to install it.',
        }
    }
  }

  switch (browser) {
    case 'safari':
      return {
        kind: 'steps',
        steps: [
          'In the menu bar, choose File → Add to Dock (or click Share in the toolbar → Add to Dock).',
          'Click Add.',
          'Open it from the Dock or Launchpad — it runs in its own window.',
        ],
        note: 'Needs macOS Sonoma (14) or later.',
      }
    case 'chrome':
      return {
        kind: 'steps',
        steps: [
          'Click the install icon at the right end of the address bar (a screen with a down arrow).',
          'No icon? Open the ⋮ menu → Cast, save and share → Install page as app….',
          'Click Install. It opens in its own window and appears with your other apps.',
        ],
        note: ALREADY_INSTALLED_CHROMIUM,
      }
    case 'edge':
      return {
        kind: 'steps',
        steps: [
          'Click the install icon at the right end of the address bar.',
          'No icon? Open the ••• menu → Apps → Install this site as an app.',
          'Click Install. It opens in its own window and appears with your other apps.',
        ],
        note: ALREADY_INSTALLED_CHROMIUM,
      }
    case 'firefox':
      return {
        kind: 'unsupported',
        message: 'Firefox on a computer cannot install web apps. Open this page in Chrome or Edge — or Safari on a Mac — to install it.',
      }
    default:
      return {
        kind: 'unsupported',
        message: 'This browser cannot install web apps. Open this page in Chrome or Edge — or Safari on a Mac — to install it.',
      }
  }
}
