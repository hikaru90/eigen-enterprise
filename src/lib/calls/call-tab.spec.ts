import { describe, expect, it, vi } from 'vitest'
import {
  CALL_TAB_BLOCKED,
  CallTabBlockedError,
  leaveDecision,
  openCallTab,
  reserveCallTab,
  type CallTabWindow,
  type OpenWindow,
} from './call-tab'

/** A tab as window.open returns it: blank, or showing `pathname` already. */
function tab(pathname = 'blank') {
  const t = {
    name: '',
    hrefs: [] as string[],
    location: {
      pathname,
      get href() {
        return `http://os.test${t.location.pathname}`
      },
      set href(v: string) {
        t.hrefs.push(v)
        t.location.pathname = v
      },
    },
    focus: vi.fn(),
    close: vi.fn(),
  }
  return t
}

const opener = (t: CallTabWindow | null) => vi.fn<OpenWindow>(() => t)

describe('openCallTab (a call whose id is known)', () => {
  it('opens a tab named after the call and points it at the call page', () => {
    const t = tab()
    const open = opener(t)
    openCallTab('call-1', open)
    expect(open).toHaveBeenCalledExactlyOnceWith('', 'ee-call-call-1')
    expect(t.hrefs).toEqual(['/calls/call-1'])
    expect(t.name).toBe('ee-call-call-1')
    expect(t.focus).toHaveBeenCalledOnce()
  })

  it('the call is open in its tab already: brings it to the front without loading it again', () => {
    const t = tab('/calls/call-1')
    openCallTab('call-1', opener(t))
    expect(t.hrefs).toEqual([])
    expect(t.focus).toHaveBeenCalledOnce()
  })

  it('the browser blocked the tab: an explicit error, nothing opened in this tab', () => {
    expect(() => openCallTab('call-1', opener(null))).toThrow(CallTabBlockedError)
    expect(() => openCallTab('call-1', opener(null))).toThrow(CALL_TAB_BLOCKED)
    expect(CALL_TAB_BLOCKED).toBe('Your browser blocked the call tab — allow pop-ups for this site')
  })
})

describe('reserveCallTab (starting a call: the id comes after an await)', () => {
  it('reserves a blank tab under a name of its own at once, then shows the call in it', () => {
    const t = tab()
    const open = opener(t)
    const r = reserveCallTab(open, () => 'u-1')
    expect(open).toHaveBeenCalledExactlyOnceWith('', 'ee-call-starting-u-1')
    expect(t.hrefs).toEqual([])
    r.show('call-9')
    expect(t.hrefs).toEqual(['/calls/call-9'])
    // Named after the call from now on: Join finds this tab.
    expect(t.name).toBe('ee-call-call-9')
    expect(t.focus).toHaveBeenCalledOnce()
    expect(t.close).not.toHaveBeenCalled()
  })

  it('starting failed: the blank tab is closed again', () => {
    const t = tab()
    reserveCallTab(opener(t), () => 'u-2').cancel()
    expect(t.close).toHaveBeenCalledOnce()
    expect(t.hrefs).toEqual([])
  })

  it('the browser blocked the tab: an explicit error before anything starts', () => {
    expect(() => reserveCallTab(opener(null), () => 'u-3')).toThrow(CallTabBlockedError)
  })
})

describe('leaveDecision (the call tab)', () => {
  it('in a call: in-app navigation is blocked, unloading asks the browser first', () => {
    expect(leaveDecision(true, false)).toBe('block')
    expect(leaveDecision(true, true)).toBe('confirm')
  })
  it('not in a call (ended, failed, never joined): anything goes', () => {
    expect(leaveDecision(false, false)).toBe('allow')
    expect(leaveDecision(false, true)).toBe('allow')
  })
})
