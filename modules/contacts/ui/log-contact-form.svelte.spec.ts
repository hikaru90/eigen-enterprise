import type { LogDraft } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import LogContactForm from './log-contact-form.svelte'

const props = { contactId: 'c1', name: 'Mara Voss', today: '2026-11-12' }

describe('log-contact-form.svelte: tell me how it went', () => {
  let submitted: number
  const countSubmit = () => {
    submitted += 1
  }
  beforeEach(() => {
    submitted = 0
    document.addEventListener('submit', countSubmit, true)
  })
  afterEach(() => document.removeEventListener('submit', countSubmit, true))

  async function tell(text: string) {
    await page.getByText('Tell me how it went').click()
    await page.getByRole('textbox', { name: 'Tell me how it went' }).fill(text)
    await page.getByRole('button', { name: 'Fill in the form' }).click()
  }

  it('prefills the day you were in touch (still today) and what comes next; nothing is logged until "Log it"', async () => {
    const read = vi.fn(async (): Promise<LogDraft> => ({ on: '2026-11-11', note: 'She liked the plan', nextFollowUpOn: '2026-11-19', nextStep: 'Send the deck' }))
    render(LogContactForm, { ...props, read })
    await tell('Spoke yesterday, deck by next Thursday')
    await expect.element(page.getByLabelText('In touch on')).toHaveValue('2026-11-11')
    expect(read).toHaveBeenCalledWith('log', 'Spoke yesterday, deck by next Thursday')
    await expect.element(page.getByLabelText('Next follow-up')).toHaveValue('2026-11-19')
    await expect.element(page.getByRole('textbox', { name: 'Next step', exact: true })).toHaveValue('Send the deck')
    await expect.element(page.getByRole('textbox', { name: 'How it went', exact: true })).toHaveValue('She liked the plan')
    await expect.element(page.getByTestId('log-prefilled')).toHaveTextContent('Nothing is logged until you press “Log it”')
    expect(submitted).toBe(0)
  })

  it('what was not said stays as it was', async () => {
    const read = vi.fn(async (): Promise<LogDraft> => ({ on: null, note: null, nextFollowUpOn: null, nextStep: 'Call back' }))
    render(LogContactForm, { ...props, read })
    await tell('Call her back')
    await expect.element(page.getByRole('textbox', { name: 'Next step', exact: true })).toHaveValue('Call back')
    await expect.element(page.getByLabelText('In touch on')).toHaveValue('2026-11-12')
    await expect.element(page.getByLabelText('Next follow-up')).toHaveValue('')
  })

  it('a step you typed is not overwritten: the change is offered', async () => {
    const read = vi.fn(async (): Promise<LogDraft> => ({ on: null, note: null, nextFollowUpOn: null, nextStep: 'Send the deck' }))
    render(LogContactForm, { ...props, read })
    await page.getByRole('textbox', { name: 'Next step', exact: true }).fill('Call back')
    await tell('I send the deck')
    await expect.element(page.getByRole('textbox', { name: 'Next step', exact: true })).toHaveValue('Call back')
    await expect.element(page.getByTestId('log-change')).toHaveTextContent(/Next step\s*Call back.*Send the deck/)
    await page.getByRole('button', { name: 'Use the new next step' }).click()
    await expect.element(page.getByRole('textbox', { name: 'Next step', exact: true })).toHaveValue('Send the deck')
    expect(submitted).toBe(0)
  })
})
