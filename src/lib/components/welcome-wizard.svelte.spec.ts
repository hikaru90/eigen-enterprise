import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

const { invalidateAllMock, gotoMock, fetchMock } = vi.hoisted(() => ({
  invalidateAllMock: vi.fn(),
  gotoMock: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('$app/navigation', () => ({
  invalidateAll: invalidateAllMock,
  goto: gotoMock,
}))

vi.mock('$app/paths', () => ({
  base: '',
  resolve: (path: string) => path,
}))

import WelcomeWizard from './welcome-wizard.svelte'

vi.mock('./provider-onboarding.svelte', async () => {
  const { default: ProviderOnboardingStub } = await import('./provider-onboarding.stub.svelte')
  return { default: ProviderOnboardingStub }
})

const LINE_OS = 'This is the operating system for your company.'
const LINE_TALK =
  'You talk. It builds — your website, your work — and it remembers everything. Nothing happens without your approval.'
const LINE_MODULAR =
  'This is a modular system. A company is made of different parts that have to work together.'
const LINE_FABRIC =
  'I am the fabric that holds everything in place and makes all the parts work together.'
const LINE_BUILD = "Let's start by building out your company."
const LINE_LOGIN =
  "First, we need a way to log you in securely — so let's set up email for your login codes."
const MIND_HEADING = 'Now, it needs a mind to think with.'

const ALL_LINES = [LINE_OS, LINE_TALK, LINE_MODULAR, LINE_FABRIC, LINE_BUILD, LINE_LOGIN]
const LINES_WITHOUT_MAIL = ALL_LINES.slice(0, 5)

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function mailCalls() {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/onboarding/mail')
}

/** Clicks Continue and waits for the next line. */
async function continueTo(text: string): Promise<void> {
  await page.getByTestId('onboarding-continue').click()
  await expect.element(page.getByText(text, { exact: true })).toBeInTheDocument()
}

/** From "Hello, Ada." through every line, ending on the last one. */
async function walkLines(lines: string[]): Promise<void> {
  await page.getByText('Hello, Ada.').click()
  await expect.element(page.getByText(lines[0], { exact: true })).toBeInTheDocument()
  for (const line of lines.slice(1)) await continueTo(line)
}

async function openMailAct(): Promise<void> {
  await walkLines(ALL_LINES)
  await page.getByTestId('onboarding-continue').click()
  await expect.element(page.getByTestId('onboarding-mail-domain')).toBeInTheDocument()
  await page.getByTestId('onboarding-have-domain').click()
  await expect.element(page.getByTestId('onboarding-mail')).toBeInTheDocument()
}

async function fillMail(): Promise<void> {
  await page.getByRole('textbox', { name: 'Access key ID' }).fill('AKIAEXAMPLE')
  await page.getByLabelText('Secret access key').fill('secret-example')
  await page.getByRole('textbox', { name: 'Send-from address' }).fill('hello@acme.test')
}

const OWNER_NO_MAIL = {
  providerReady: false,
  needsMail: true,
  byokUiEnabled: true,
  displayName: 'Ada',
}

describe('welcome-wizard.svelte — the boot sequence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockResolvedValue(json(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.removeItem('ee-sound')
    window.localStorage.setItem('ee-voice', 'off')
    return () => {
      vi.unstubAllGlobals()
      window.localStorage.removeItem('ee-voice')
    }
  })

  it('opens as a cinematic boot — a light, a greeting, no form-wizard chrome', async () => {
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true, displayName: null })

    await expect.element(page.getByTestId('welcome-wizard')).toBeInTheDocument()
    await expect.element(page.getByTestId('boot-orb')).toBeInTheDocument()
    await expect.element(page.getByText('Hello.')).toBeInTheDocument()
    await expect.element(page.getByText(/Step \d of \d/)).not.toBeInTheDocument()
  })

  it('asks for the name once, persists it, and greets by it', async () => {
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true, displayName: null })

    await page.getByText('What should I call you?').click()
    const nameInput = page.getByRole('textbox', { name: 'Your name' })
    await nameInput.fill('Ada')
    await page.getByRole('button', { name: 'Continue' }).click()

    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === '/api/onboarding/name')
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as { body: string }).body)).toEqual({ name: 'Ada' })
    })
    await expect.element(page.getByText(LINE_OS)).toBeInTheDocument()
  })

  it('a known name skips the ask entirely', async () => {
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true, displayName: 'Ada' })

    await expect.element(page.getByText('Hello, Ada.')).toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'Your name' })).not.toBeInTheDocument()
  })

  it('says one line per step, each with Continue and Back — never stranded', async () => {
    render(WelcomeWizard, OWNER_NO_MAIL)
    await page.getByText('Hello, Ada.').click()
    await expect.element(page.getByText(LINE_OS)).toBeInTheDocument()
    for (let i = 1; i < ALL_LINES.length; i++) {
      await continueTo(ALL_LINES[i])
      await expect
        .element(page.getByText(ALL_LINES[i - 1], { exact: true }))
        .not.toBeInTheDocument()
      await expect.element(page.getByTestId('onboarding-back')).toBeInTheDocument()
    }
    // Back walks the lines in reverse.
    await page.getByTestId('onboarding-back').click()
    await expect.element(page.getByText(LINE_BUILD)).toBeInTheDocument()
    await page.getByTestId('onboarding-back').click()
    await expect.element(page.getByText(LINE_FABRIC)).toBeInTheDocument()

    for (const jargon of ['Nucleus', 'Capture', 'Knowledge graph', 'Brand studio']) {
      await expect.element(page.getByText(jargon)).not.toBeInTheDocument()
    }
  })

  it('before Amazon, the owner learns they need a domain and DNS access to it', async () => {
    render(WelcomeWizard, OWNER_NO_MAIL)
    await walkLines(ALL_LINES)
    await page.getByTestId('onboarding-continue').click()

    const domain = page.getByTestId('onboarding-mail-domain')
    await expect.element(domain).toBeInTheDocument()
    await expect.element(domain.getByText(/your own domain/).first()).toBeInTheDocument()
    await expect.element(domain.getByText(/DNS/).first()).toBeInTheDocument()
    await expect.element(page.getByTestId('onboarding-mail')).not.toBeInTheDocument()

    await page.getByTestId('onboarding-have-domain').click()
    await expect.element(page.getByTestId('onboarding-mail')).toBeInTheDocument()
    await page.getByTestId('onboarding-back').click()
    await expect.element(page.getByTestId('onboarding-mail-domain')).toBeInTheDocument()
  })

  it('an owner without email is guided to Amazon SES after the lines, before the mind', async () => {
    render(WelcomeWizard, OWNER_NO_MAIL)
    await openMailAct()

    await expect.element(page.getByTestId('provider-onboarding')).not.toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: /Amazon SES console/ }))
      .toHaveAttribute('href', 'https://console.aws.amazon.com/ses/')
    await expect
      .element(page.getByRole('link', { name: 'AWS user page' }))
      .toHaveAttribute('href', 'https://console.aws.amazon.com/iam/home#/users/create')
    await expect.element(page.getByRole('combobox', { name: 'Region' })).toHaveValue('eu-central-1')
    await expect
      .element(page.getByLabelText('Secret access key'))
      .toHaveAttribute('type', 'password')

    await page.getByTestId('onboarding-back').click()
    await page.getByTestId('onboarding-back').click()
    await expect.element(page.getByText(LINE_LOGIN)).toBeInTheDocument()
  })

  it('a sent test email confirms, then Continue leads to the mind', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/onboarding/mail'
          ? json(200, { ok: true, testSentTo: 'ada@acme.test' })
          : json(200, { ok: true }),
      ),
    )
    render(WelcomeWizard, OWNER_NO_MAIL)
    await openMailAct()
    await page.getByRole('combobox', { name: 'Region' }).selectOptions('us-east-1')
    await fillMail()
    await page.getByRole('button', { name: 'Send me a test email' }).click()

    await expect.element(page.getByText('Test email sent to ada@acme.test')).toBeInTheDocument()
    expect(JSON.parse((mailCalls()[0][1] as { body: string }).body)).toEqual({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-example',
      emailFrom: 'hello@acme.test',
    })
    await page.getByTestId('onboarding-continue').click()
    await expect.element(page.getByText(MIND_HEADING)).toBeInTheDocument()
    await expect.element(page.getByTestId('provider-onboarding')).toBeInTheDocument()
  })

  it('an unverified sender asks the user to click Amazon’s link, then Try again re-submits', async () => {
    let attempt = 0
    fetchMock.mockImplementation((url: string) => {
      if (url !== '/api/onboarding/mail') return Promise.resolve(json(200, { ok: true }))
      attempt++
      return Promise.resolve(
        attempt === 1
          ? json(409, { error: 'unverified', needs: 'verify_sender', emailFrom: 'hello@acme.test' })
          : json(200, { ok: true, testSentTo: 'ada@acme.test' }),
      )
    })
    render(WelcomeWizard, OWNER_NO_MAIL)
    await openMailAct()
    await fillMail()
    await page.getByRole('button', { name: 'Send me a test email' }).click()

    await expect
      .element(
        page.getByText(
          'Amazon sent a verification email to hello@acme.test. Click the link in it, then press Try again.',
        ),
      )
      .toBeInTheDocument()
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect.element(page.getByText('Test email sent to ada@acme.test')).toBeInTheDocument()
    expect(mailCalls()).toHaveLength(2)
  })

  it('a rejected setup shows the error and stays on the email step', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/onboarding/mail'
          ? json(400, { error: 'Amazon did not accept that access key.' })
          : json(200, { ok: true }),
      ),
    )
    render(WelcomeWizard, OWNER_NO_MAIL)
    await openMailAct()
    await fillMail()
    await page.getByRole('button', { name: 'Send me a test email' }).click()

    await expect
      .element(page.getByText('Amazon did not accept that access key.'))
      .toBeInTheDocument()
    await expect.element(page.getByTestId('onboarding-mail')).toBeInTheDocument()
    await expect.element(page.getByText(MIND_HEADING)).not.toBeInTheDocument()
  })

  it('with email already working, the login line and email step are skipped', async () => {
    render(WelcomeWizard, { ...OWNER_NO_MAIL, needsMail: false })
    await walkLines(LINES_WITHOUT_MAIL)
    await page.getByTestId('onboarding-continue').click()

    await expect.element(page.getByText(MIND_HEADING)).toBeInTheDocument()
    await expect.element(page.getByTestId('onboarding-mail')).not.toBeInTheDocument()
    await expect.element(page.getByText(LINE_LOGIN)).not.toBeInTheDocument()
  })

  it('without a mind, the gate is connecting one — or a muted skip', async () => {
    const oncomplete = vi.fn()
    render(WelcomeWizard, {
      providerReady: false,
      byokUiEnabled: true,
      displayName: 'Ada',
      oncomplete,
    })
    await walkLines(LINES_WITHOUT_MAIL)
    await page.getByTestId('onboarding-continue').click()
    await expect.element(page.getByTestId('provider-onboarding')).toBeInTheDocument()
    await expect.element(page.getByTestId('onboarding-back')).toBeInTheDocument()

    await page.getByTestId('skip-onboarding').click()
    await vi.waitFor(() => {
      expect(oncomplete).toHaveBeenCalledWith({ name: 'Ada' })
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onboarding/welcome',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('the mind connecting hands off to the chat — the tour completes', async () => {
    const oncomplete = vi.fn()
    render(WelcomeWizard, {
      providerReady: false,
      byokUiEnabled: true,
      displayName: 'Ada',
      oncomplete,
    })
    await walkLines(LINES_WITHOUT_MAIL)
    await page.getByTestId('onboarding-continue').click()
    await page.getByTestId('simulate-connected').click()

    await vi.waitFor(() => {
      expect(oncomplete).toHaveBeenCalledWith({ name: 'Ada' })
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onboarding/welcome',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    const foundingCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/onboarding/founding')
    expect(foundingCalls).toEqual([])
  })

  it('with a working mind and email, Begin on the last line hands off', async () => {
    const oncomplete = vi.fn()
    render(WelcomeWizard, {
      providerReady: true,
      byokUiEnabled: true,
      displayName: 'Ada',
      oncomplete,
    })
    await walkLines(LINES_WITHOUT_MAIL)
    await expect.element(page.getByTestId('onboarding-continue')).toHaveTextContent('Begin')
    await page.getByTestId('onboarding-continue').click()

    await vi.waitFor(() => {
      expect(oncomplete).toHaveBeenCalledWith({ name: 'Ada' })
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onboarding/welcome',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('skip is reachable from the very first act and means complete-once', async () => {
    const oncomplete = vi.fn()
    render(WelcomeWizard, {
      providerReady: true,
      byokUiEnabled: true,
      displayName: null,
      oncomplete,
    })

    await page.getByTestId('skip-onboarding').click()

    await vi.waitFor(() => {
      expect(oncomplete).toHaveBeenCalledWith({ name: null })
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onboarding/welcome',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('a failed name save fails loud and stays on the ask', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/onboarding/name' ? json(400, { error: 'No.' }) : json(200, { ok: true }),
      ),
    )
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true, displayName: null })

    const nameInput = page.getByRole('textbox', { name: 'Your name' })
    await nameInput.fill('Ada')
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect.element(page.getByText('No.')).toBeInTheDocument()
    await expect.element(page.getByText('What should I call you?')).toBeInTheDocument()
    const welcomeCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/onboarding/welcome')
    expect(welcomeCalls).toEqual([])
  })
})
