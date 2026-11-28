/**
 * Enter sends, Shift+Enter is a new line — one rule for every send-style
 * textbox (owner wish 70a54b68). An IME composition (isComposing, or the
 * legacy keyCode 229) is the input method's Enter, never a send.
 */
export function isSendKey(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229
}

/**
 * A keydown handler: on a send key it stops the newline and sends. Without
 * `send` it submits the textbox's own form (requestSubmit, so validation and
 * onsubmit run). Other keys pass through untouched.
 */
export function enterSends(send?: () => void) {
  return (e: KeyboardEvent & { currentTarget: EventTarget | null }) => {
    if (!isSendKey(e)) return
    e.preventDefault()
    if (send) return send()
    const form = (e.currentTarget as HTMLTextAreaElement | null)?.form
    if (!form) throw new Error('enterSends: no send given and the textbox has no form')
    form.requestSubmit()
  }
}
