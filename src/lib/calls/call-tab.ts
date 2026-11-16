/**
 * A call always runs in its own browser tab (owner, 2026-11-16: "a call
 * always opens in a separate tab, so the main instance is kept clean").
 * Every way into a call — Call / Join in a conversation, Accept on the
 * incoming-call toast, Join / New meeting on /calls — opens it here, from the
 * click handler itself (a popup blocker only allows a tab opened during the
 * click).
 *
 * The tab is named after the call (`ee-call-<id>`): asking for the same call
 * again finds that tab and brings it to the front instead of loading it a
 * second time (a reload would leave the call). A blocked tab is an explicit
 * error — never a fallback to the current tab, which would put the call back
 * into the main instance.
 */

/** What this module needs of a browser window (the real one or a spec's fake). */
export type CallTabWindow = {
  name: string
  location: { href: string; pathname: string }
  focus(): void
  close(): void
}

/** window.open: null when the browser blocked the tab. */
export type OpenWindow = (url: string, target: string) => CallTabWindow | null

export const CALL_TAB_BLOCKED = 'Your browser blocked the call tab — allow pop-ups for this site'

export class CallTabBlockedError extends Error {
  constructor() {
    super(CALL_TAB_BLOCKED)
    this.name = 'CallTabBlockedError'
  }
}

export const callTabName = (callId: string) => `ee-call-${callId}`
export const callPath = (callId: string) => `/calls/${encodeURIComponent(callId)}`

const browserOpen: OpenWindow = (url, target) => window.open(url, target) as CallTabWindow | null

/** Point a tab at the call (unless it shows that call already) and bring it to the front. */
function show(tab: CallTabWindow, callId: string): void {
  tab.name = callTabName(callId)
  const path = callPath(callId)
  if (tab.location.pathname !== path) tab.location.href = path
  tab.focus()
}

/**
 * A call whose id is known (Join, Accept, back to my call): open its tab, or
 * bring it to the front when it is open already. Call it synchronously in the
 * click handler. Throws CallTabBlockedError when the browser refused the tab.
 */
export function openCallTab(callId: string, open: OpenWindow = browserOpen): void {
  // An empty URL opens a blank tab, or returns the named one untouched (no reload).
  const tab = open('', callTabName(callId))
  if (!tab) throw new CallTabBlockedError()
  show(tab, callId)
}

/** A tab reserved before the call exists (starting a call or a meeting). */
export type CallTabReservation = {
  /** The call was started: show it in the reserved tab. */
  show(callId: string): void
  /** Starting failed: close the blank tab again. */
  cancel(): void
}

/**
 * Starting a call: the id comes back from the server only after an await, by
 * when the click no longer counts for the popup blocker. So the tab is
 * reserved synchronously in the click (a blank tab under a name of its own)
 * and pointed at the call once it exists. Throws CallTabBlockedError when the
 * browser refused the tab — check that before starting anything, so no one is
 * rung for a call I cannot open.
 */
export function reserveCallTab(open: OpenWindow = browserOpen, uniqueId: () => string = () => crypto.randomUUID()): CallTabReservation {
  const tab = open('', `ee-call-starting-${uniqueId()}`)
  if (!tab) throw new CallTabBlockedError()
  return {
    show: (callId) => show(tab, callId),
    cancel: () => tab.close(),
  }
}

/** What the call tab does with a navigation away from it. */
export type LeaveDecision = 'allow' | 'block' | 'confirm'

/**
 * The call tab while I am in its call: an in-app navigation away is blocked
 * (hang up first); unloading the page (reload, close, an address typed in)
 * asks the browser's own "leave this page?" first. Not in a call: anything goes.
 */
export function leaveDecision(inCall: boolean, willUnload: boolean): LeaveDecision {
  if (!inCall) return 'allow'
  return willUnload ? 'confirm' : 'block'
}
