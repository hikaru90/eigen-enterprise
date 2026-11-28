import { describe, expect, it, vi } from 'vitest'
import { enterSends, isSendKey } from './enter-sends'

const key = (init: Partial<KeyboardEvent>) =>
  ({
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    preventDefault: vi.fn(),
    currentTarget: null,
    ...init,
  }) as unknown as KeyboardEvent & { currentTarget: EventTarget | null }

describe('enter sends, shift+enter breaks the line', () => {
  it('Enter is a send key', () => expect(isSendKey(key({}))).toBe(true))
  it('Shift+Enter is not', () => expect(isSendKey(key({ shiftKey: true }))).toBe(false))
  it('an IME composition is not', () => {
    expect(isSendKey(key({ isComposing: true }))).toBe(false)
    expect(isSendKey(key({ keyCode: 229 }))).toBe(false)
  })
  it('other keys are not', () => expect(isSendKey(key({ key: 'a' }))).toBe(false))

  it('sends and stops the newline on Enter', () => {
    const send = vi.fn()
    const e = key({})
    enterSends(send)(e)
    expect(send).toHaveBeenCalledOnce()
    expect(e.preventDefault).toHaveBeenCalledOnce()
  })
  it('leaves Shift+Enter to the textbox', () => {
    const send = vi.fn()
    const e = key({ shiftKey: true })
    enterSends(send)(e)
    expect(send).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
  it('submits the own form without a send', () => {
    const requestSubmit = vi.fn()
    enterSends()(key({ currentTarget: { form: { requestSubmit } } as unknown as EventTarget }))
    expect(requestSubmit).toHaveBeenCalledOnce()
  })
  it('fails loud without send or form', () => {
    expect(() => enterSends()(key({ currentTarget: {} as EventTarget }))).toThrow(/no form/)
  })
})
