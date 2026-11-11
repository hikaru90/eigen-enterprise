import type { InstallEnvironment } from './install-prompt'

/**
 * The live browser side of "Install app": the install slot src/app.html fills
 * from beforeinstallprompt / appinstalled before the app boots, read into an
 * InstallEnvironment for installGuide (src/lib/pwa/install-prompt.ts).
 */

export type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallSlot = { prompt: BeforeInstallPromptEvent | null; installed: boolean }

export const INSTALL_CHANGE_EVENT = 'ee-install-change'

function installSlot(): InstallSlot {
  const slot = window.__eeInstall
  if (!slot) throw new Error('[pwa] the install capture in src/app.html did not run — window.__eeInstall is missing')
  return slot
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function readInstallEnvironment(): InstallEnvironment {
  const slot = installSlot()
  return {
    standalone: isStandalone(),
    secureContext: window.isSecureContext,
    nativePrompt: slot.prompt !== null,
    installedThisSession: slot.installed,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
  }
}

/** Calls back whenever the browser offers the install dialog or reports an install. */
export function onInstallChange(callback: () => void): () => void {
  window.addEventListener(INSTALL_CHANGE_EVENT, callback)
  return () => window.removeEventListener(INSTALL_CHANGE_EVENT, callback)
}

/**
 * Opens the browser's own install dialog. The captured event is single-use,
 * so it is cleared first; a dismissed dialog is not offered again until the
 * browser fires a new one (the guide then shows the menu path).
 */
export async function runNativeInstall(): Promise<'accepted' | 'dismissed'> {
  const slot = installSlot()
  const event = slot.prompt
  if (!event) throw new Error('The browser has no install dialog ready.')
  slot.prompt = null
  await event.prompt()
  const { outcome } = await event.userChoice
  return outcome
}
