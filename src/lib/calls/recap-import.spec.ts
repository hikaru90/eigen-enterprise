import { describe, expect, it } from 'vitest'
import { recapImportDraft, recapImportHref } from './recap-import'

describe('recap import (the recap into the brain, approved in the chat first)', () => {
  it('the draft names the call and asks the assistant to propose first and wait for an OK', () => {
    const draft = recapImportDraft({ id: 'call-7', title: 'Weekly with Acme' })
    expect(draft).toContain('“Weekly with Acme”')
    expect(draft).toContain('call call-7')
    expect(draft).toMatch(/wait for my OK before saving anything/)
    // It names where things may go: Memory notes, tasks, projects.
    expect(draft).toMatch(/notes/)
    expect(draft).toMatch(/tasks/)
    expect(draft).toMatch(/project/)
  })

  it('the link carries the draft as ?prefill= (a draft in the composer, never sent by itself)', () => {
    const href = recapImportHref('/', { id: 'call-7', title: 'Weekly with Acme' })
    const url = new URL(href, 'https://os.example')
    expect(url.pathname).toBe('/')
    expect(url.searchParams.get('prefill')).toBe(recapImportDraft({ id: 'call-7', title: 'Weekly with Acme' }))
  })

  it('on a page inside the app shell the link stays on that page', () => {
    const href = recapImportHref('', { id: 'call-7', title: 'X' })
    expect(href.startsWith('?prefill=')).toBe(true)
  })
})
