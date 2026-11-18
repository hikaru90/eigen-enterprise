import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ReplyQuote from './reply-quote.svelte'

const quote = {
  id: 'o1',
  parentId: null,
  deleted: false,
  authorId: 'bea',
  authorName: 'Bea Member',
  snippet: 'Can you send the deck?',
  attachment: null,
  call: false,
}

describe('reply-quote.svelte', () => {
  it('in the composer: "Replying to" the author, the first line, and a cancel button', async () => {
    const ondismiss = vi.fn()
    render(ReplyQuote, { quote, composer: true, ondismiss })
    await expect.element(page.getByTestId('reply-preview')).toBeVisible()
    await expect.element(page.getByTestId('reply-quote-author')).toHaveTextContent('Replying to Bea Member')
    await expect.element(page.getByTestId('reply-quote-snippet')).toHaveTextContent('Can you send the deck?')
    await page.getByRole('button', { name: 'Cancel reply' }).click()
    expect(ondismiss).toHaveBeenCalledOnce()
  })

  it('a photo with several files says "Photo +1"', async () => {
    render(ReplyQuote, { quote: { ...quote, snippet: '', attachment: { kind: 'image' as const, label: 'Photo', count: 2 } } })
    await expect.element(page.getByTestId('reply-quote-file')).toHaveTextContent('Photo +1')
    await expect.element(page.getByTestId('reply-quote-file')).toHaveAttribute('data-kind', 'image')
  })

  it('above a reply it is a button naming the original', async () => {
    const onopen = vi.fn()
    render(ReplyQuote, { quote, onopen })
    await page.getByRole('button', { name: /Show the original message — Bea Member: Can you send the deck\?/ }).click()
    expect(onopen).toHaveBeenCalledOnce()
  })
})
