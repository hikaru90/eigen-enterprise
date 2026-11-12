import type { ContactDraft, ContactDto } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { page as appPage } from '$app/state'
import { FakeMediaRecorder, installVoiceDoubles } from '$lib/test/voice-doubles'
import { VOICE_TRANSCRIBE_URL } from '$lib/voice/transcribe-voice-clip'
import ContactForm from './contact-form.svelte'

const contact = (over: Partial<ContactDto> = {}): ContactDto => ({
  id: 'c1',
  name: 'Mara Voss',
  organisation: 'Northwind Capital',
  title: 'Partner',
  channels: [{ type: 'linkedin', value: 'https://www.linkedin.com/in/mara' }],
  metHow: 'Founders breakfast',
  whyRelevant: 'Leads seed rounds',
  tags: ['investor', 'seed round'],
  lastContactedOn: '2026-11-01',
  nextFollowUpOn: '2026-11-20',
  nextStep: 'Send the deck',
  shared: false,
  own: true,
  createdByName: 'Ana Lind',
  canManage: true,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  ...over,
})

describe('contact-form.svelte', () => {
  it('offers the default tags (partner, customer, funder, investor, production) and one empty channel to start', async () => {
    render(ContactForm, { submitLabel: 'Add contact', offerShare: true })
    for (const tag of ['partner', 'customer', 'funder', 'investor', 'production']) {
      await expect.element(page.getByRole('checkbox', { name: tag })).not.toBeChecked()
    }
    await expect.element(page.getByRole('textbox', { name: 'Channel 1' })).toHaveValue('')
    await expect.element(page.getByRole('combobox', { name: 'Channel 1 type' })).toHaveValue('email')
    await expect.element(page.getByTestId('contact-share-now')).not.toBeChecked()
    await expect.element(page.getByText(/only you, the company owner and admins/i)).toBeVisible()
  })

  it('edits an existing contact: its values, its own tags checked, its channels', async () => {
    render(ContactForm, { contact: contact(), suggestedTags: ['printing'], submitLabel: 'Save', action: '?/save' })
    await expect.element(page.getByLabelText('Name')).toHaveValue('Mara Voss')
    await expect.element(page.getByLabelText('Role or title')).toHaveValue('Partner')
    await expect.element(page.getByRole('checkbox', { name: 'investor' })).toBeChecked()
    await expect.element(page.getByRole('checkbox', { name: 'seed round' })).toBeChecked()
    await expect.element(page.getByRole('checkbox', { name: 'printing' })).not.toBeChecked()
    await expect.element(page.getByRole('combobox', { name: 'Channel 1 type' })).toHaveValue('linkedin')
    await expect.element(page.getByLabelText('Next follow-up')).toHaveValue('2026-11-20')
    await expect.element(page.getByTestId('contact-share-now')).not.toBeInTheDocument()
  })

  it('adds and removes channels; removing the last leaves one empty row', async () => {
    render(ContactForm, { contact: contact(), submitLabel: 'Save' })
    await page.getByRole('button', { name: 'Add a channel' }).click()
    await expect.element(page.getByRole('textbox', { name: 'Channel 2' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Channel 2' }).fill('+49 30 1234')
    await page.getByRole('button', { name: 'Remove channel 1' }).click()
    await expect.element(page.getByRole('textbox', { name: 'Channel 1' })).toHaveValue('+49 30 1234')
    await page.getByRole('button', { name: 'Remove channel 1' }).click()
    await expect.element(page.getByRole('textbox', { name: 'Channel 1' })).toHaveValue('')
    expect(page.getByTestId('channel-row').elements()).toHaveLength(1)
  })

  it('shows the server’s refusal', async () => {
    render(ContactForm, { submitLabel: 'Add contact', error: 'Give the contact a name.' })
    await expect.element(page.getByRole('alert')).toHaveTextContent('Give the contact a name.')
  })
})

// ── "Tell me about them" ──────────────────────────────────────────────────────

const draft = (over: Partial<ContactDraft> = {}): ContactDraft => ({
  name: null,
  organisation: null,
  title: null,
  channels: [],
  metHow: null,
  whyRelevant: null,
  tags: [],
  lastContactedOn: null,
  nextFollowUpOn: null,
  nextStep: null,
  ...over,
})

const field = (name: string) => page.getByRole('textbox', { name, exact: true })

describe('contact-form.svelte: tell me about them', () => {
  let submitted: number
  const countSubmit = () => {
    submitted += 1
  }
  beforeEach(() => {
    submitted = 0
    document.addEventListener('submit', countSubmit, true)
  })
  afterEach(() => {
    document.removeEventListener('submit', countSubmit, true)
    appPage.data = {}
  })

  it('typed description → the AI’s reading prefills the empty form; nothing is sent until Save', async () => {
    const read = vi.fn(async () =>
      draft({
        name: 'Mara Voss',
        organisation: 'Northwind Capital',
        channels: [
          { type: 'email', value: 'mara@northwind.example' },
          { type: 'phone', value: '+49 30 1234567' },
        ],
        whyRelevant: 'Leads seed rounds',
        tags: ['investor'],
        nextFollowUpOn: '2026-11-19',
        nextStep: 'Send the deck',
      }),
    )
    render(ContactForm, { submitLabel: 'Add contact', offerShare: true, describeOpen: true, read })
    await page.getByRole('textbox', { name: 'Tell me about them' }).fill('Mara Voss from Northwind, an investor')
    await page.getByRole('button', { name: 'Fill in the form' }).click()

    await expect.element(field('Name')).toHaveValue('Mara Voss')
    expect(read).toHaveBeenCalledWith('contact', 'Mara Voss from Northwind, an investor')
    await expect.element(field('Organisation')).toHaveValue('Northwind Capital')
    // what wasn't said stays empty
    await expect.element(field('Role or title')).toHaveValue('')
    await expect.element(field('Where or how you met')).toHaveValue('')
    await expect.element(field('Why they matter, in your words')).toHaveValue('Leads seed rounds')
    // the empty starter row gave way to what was said
    await expect.element(page.getByRole('combobox', { name: 'Channel 1 type' })).toHaveValue('email')
    await expect.element(field('Channel 1')).toHaveValue('mara@northwind.example')
    await expect.element(page.getByRole('combobox', { name: 'Channel 2 type' })).toHaveValue('phone')
    await expect.element(field('Channel 2')).toHaveValue('+49 30 1234567')
    expect(page.getByTestId('channel-row').elements()).toHaveLength(2)
    await expect.element(page.getByRole('checkbox', { name: 'investor' })).toBeChecked()
    await expect.element(page.getByRole('checkbox', { name: 'partner' })).not.toBeChecked()
    await expect.element(page.getByLabelText('Next follow-up')).toHaveValue('2026-11-19')
    await expect.element(field('Next step')).toHaveValue('Send the deck')
    await expect.element(page.getByTestId('contact-prefilled')).toHaveTextContent('nothing is saved until you press Add contact')
    expect(submitted).toBe(0)
  })

  it('a dictated description goes into the box and is read right away', async () => {
    const doubles = installVoiceDoubles()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ transcript: 'Jon Park, printer in Leipzig' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    appPage.data = { shell: { dictation: { ready: true } } }
    try {
      const read = vi.fn(async () => draft({ name: 'Jon Park', title: 'Printer', tags: ['production'] }))
      render(ContactForm, { submitLabel: 'Add contact', describeOpen: true, read })
      await page.getByTestId('contact-describe-voice-mic').click()
      await expect.element(page.getByTestId('contact-describe-voice-bar')).toBeInTheDocument()
      FakeMediaRecorder.instances.at(-1)!.emitChunk([1, 2, 3])
      await page.getByTestId('contact-describe-voice-send').click()

      await expect.element(field('Name')).toHaveValue('Jon Park')
      expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(VOICE_TRANSCRIBE_URL)
      expect(read).toHaveBeenCalledWith('contact', 'Jon Park, printer in Leipzig')
      await expect.element(page.getByRole('textbox', { name: 'Tell me about them' })).toHaveValue('Jon Park, printer in Leipzig')
      await expect.element(field('Role or title')).toHaveValue('Printer')
      await expect.element(page.getByRole('checkbox', { name: 'production' })).toBeChecked()
      expect(submitted).toBe(0)
    } finally {
      doubles.restore()
      vi.unstubAllGlobals()
    }
  })

  it('without speech (no OpenRouter) the mic says why — typing still works', async () => {
    appPage.data = { shell: { dictation: { ready: false, missing: 'openrouter_key' } } }
    const read = vi.fn(async () => draft({ name: 'Mara Voss' }))
    render(ContactForm, { submitLabel: 'Add contact', describeOpen: true, read })
    await expect.element(page.getByTestId('contact-describe-voice-mic')).toBeDisabled()
    await page.getByRole('textbox', { name: 'Tell me about them' }).fill('Mara Voss')
    await page.getByRole('button', { name: 'Fill in the form' }).click()
    await expect.element(field('Name')).toHaveValue('Mara Voss')
  })

  it('editing: existing values are not overwritten — the change is shown to accept or keep; empty ones fill in', async () => {
    const read = vi.fn(async () =>
      draft({
        name: 'Mara Voss',
        organisation: 'Acme Ventures',
        title: 'Managing partner',
        metHow: 'Founders breakfast',
        channels: [
          { type: 'linkedin', value: 'https://www.linkedin.com/in/mara' },
          { type: 'email', value: 'mara@acme.example' },
        ],
        tags: ['partner'],
      }),
    )
    render(ContactForm, { contact: contact({ metHow: null }), submitLabel: 'Save', action: '?/save', read })
    // folded away on the edit form: the fields come first
    await expect.element(page.getByTestId('contact-describe-text')).not.toBeVisible()
    await page.getByText('Tell me about them').click()
    await page.getByRole('textbox', { name: 'Tell me about them' }).fill('Mara moved to Acme Ventures as managing partner')
    await page.getByRole('button', { name: 'Fill in the form' }).click()

    // the same name is no change; the empty "where you met" fills in
    await expect.element(field('Where or how you met')).toHaveValue('Founders breakfast')
    // different values stay as they are until accepted
    await expect.element(field('Organisation')).toHaveValue('Northwind Capital')
    await expect.element(field('Role or title')).toHaveValue('Partner')
    const changes = page.getByTestId('contact-change')
    expect(changes.elements()).toHaveLength(2)
    await expect.element(changes.nth(0)).toHaveTextContent(/Organisation\s*Northwind Capital.*Acme Ventures/)
    await expect.element(changes.nth(1)).toHaveTextContent(/Role or title\s*Partner.*Managing partner/)

    await page.getByRole('button', { name: 'Use the new organisation' }).click()
    await expect.element(field('Organisation')).toHaveValue('Acme Ventures')
    await page.getByRole('button', { name: 'Keep the current role or title' }).click()
    await expect.element(field('Role or title')).toHaveValue('Partner')
    await expect.element(page.getByTestId('contact-changes')).not.toBeInTheDocument()

    // channels and tags are only added
    expect(page.getByTestId('channel-row').elements()).toHaveLength(2)
    await expect.element(field('Channel 1')).toHaveValue('https://www.linkedin.com/in/mara')
    await expect.element(field('Channel 2')).toHaveValue('mara@acme.example')
    await expect.element(page.getByRole('checkbox', { name: 'investor' })).toBeChecked()
    await expect.element(page.getByRole('checkbox', { name: 'partner' })).toBeChecked()
    expect(submitted).toBe(0)
  })

  it('"Use all new values" takes every change', async () => {
    const read = vi.fn(async () => draft({ organisation: 'Acme Ventures', title: 'Managing partner' }))
    render(ContactForm, { contact: contact(), submitLabel: 'Save', describeOpen: true, read })
    await page.getByRole('textbox', { name: 'Tell me about them' }).fill('Mara moved to Acme')
    await page.getByRole('button', { name: 'Fill in the form' }).click()
    await page.getByRole('button', { name: 'Use all new values' }).click()
    await expect.element(field('Organisation')).toHaveValue('Acme Ventures')
    await expect.element(field('Role or title')).toHaveValue('Managing partner')
  })

  it('a failed reading says why and leaves the form as it was; typing works as before', async () => {
    const read = vi.fn(async () => {
      throw new Error('The company has no AI provider set up yet.')
    })
    render(ContactForm, { contact: contact(), submitLabel: 'Save', describeOpen: true, read })
    await page.getByRole('textbox', { name: 'Tell me about them' }).fill('Mara moved to Acme')
    await page.getByRole('button', { name: 'Fill in the form' }).click()
    await expect.element(page.getByTestId('contact-describe-error')).toHaveTextContent('no AI provider')
    await expect.element(field('Organisation')).toHaveValue('Northwind Capital')
    await field('Organisation').fill('Acme')
    await expect.element(field('Organisation')).toHaveValue('Acme')
  })

  it('"Fill in the form" waits for something to read', async () => {
    const read = vi.fn()
    render(ContactForm, { submitLabel: 'Add contact', describeOpen: true, read })
    await expect.element(page.getByRole('button', { name: 'Fill in the form' })).toBeDisabled()
    expect(read).not.toHaveBeenCalled()
  })
})
