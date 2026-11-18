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

  it('back from the provider sign-in redirect, the tour does not replay — it hands off', async () => {
    const oncomplete = vi.fn()
    render(WelcomeWizard, {
      providerReady: true,
      byokUiEnabled: true,
      displayName: 'Ada',
      returnedFromProvider: true,
      oncomplete,
    })
    await vi.waitFor(() => expect(oncomplete).toHaveBeenCalledWith({ name: 'Ada' }))
    await expect.element(page.getByText('Hello, Ada.')).not.toBeInTheDocument()
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

// ─── The Domain and Email acts (plan/managed-domains.md) ──────────────────────

const REGISTRANT = { firstName: 'Ada', lastName: 'Lovelace', organization: 'Acme GmbH', email: 'ada@acme.test' }
const MANAGED_BUY = {
  ...OWNER_NO_MAIL,
  domainSetup: { managedMail: true, canBuy: true, registrant: REGISTRANT },
  domainPollMs: 20,
}
const MANAGED_NO_BUY = { ...OWNER_NO_MAIL, domainSetup: { managedMail: true, canBuy: false, registrant: null } }

type Call = [string, { method?: string; body?: string } | undefined]
const callsTo = (url: string) => (fetchMock.mock.calls as Call[]).filter(([u]) => u === url)

const dkim = (name: string, status: string) => ({
  purpose: 'dkim',
  type: 'CNAME',
  name: `a1._domainkey.${name}`,
  host: 'a1._domainkey',
  value: 'a1.dkim.amazonses.com',
  priority: null,
  status,
  required: true,
})
const connectedDomain = (name: string, verified: boolean) => ({
  id: 'd-1',
  name,
  status: verified ? 'SUCCESS' : 'PENDING',
  sendable: verified,
  isVerifying: !verified,
  errorMessage: null,
  adopted: false,
  lastCheckedAt: null,
  records: [dkim(name, verified ? 'SUCCESS' : 'PENDING')],
})

/** A fake os: domains API + sender route; `states` is what successive reads of /api/domains show for acme.eu. */
function fakeOs(opts: { states?: string[]; purchase?: { status: number; body: unknown } } = {}) {
  const states = [...(opts.states ?? [])]
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith('/api/domains/search')) {
      return Promise.resolve(
        json(200, {
          results: [
            { name: 'acme.eu', available: true, priceCents: 1200, currency: 'EUR' },
            { name: 'acme.com', available: false, priceCents: null, currency: 'EUR' },
          ],
        }),
      )
    }
    if (url === '/api/domains/purchases') {
      return Promise.resolve(
        json(opts.purchase?.status ?? 202, opts.purchase?.body ?? { name: 'acme.eu', state: 'charging' }),
      )
    }
    if (url === '/api/domains') {
      const state = states.length > 1 ? states.shift()! : states[0]
      const error = state === 'failed' ? 'The registry refused acme.eu.' : null
      return Promise.resolve(
        json(200, {
          canBuy: true,
          domains: state ? [{ name: 'acme.eu', state, error, renewsAt: null, autoRenew: true }] : [],
        }),
      )
    }
    if (url === '/api/domains/connected') {
      const { name } = JSON.parse(init!.body!) as { name: string }
      return Promise.resolve(json(200, { domain: connectedDomain(name, false) }))
    }
    if (url === '/api/domains/connected/d-1/check') {
      return Promise.resolve(json(200, { domain: connectedDomain('acme.test', true) }))
    }
    if (url === '/api/onboarding/sender') {
      const { address } = JSON.parse(init!.body!) as { address: string }
      return Promise.resolve(json(200, { ok: true, address, ready: false }))
    }
    return Promise.resolve(json(200, { ok: true }))
  })
}

async function openDomainAct(): Promise<void> {
  await walkLines(ALL_LINES)
  await page.getByTestId('onboarding-continue').click()
  await expect.element(page.getByTestId('onboarding-mail-domain')).toBeInTheDocument()
}

async function fillRegistrant(): Promise<void> {
  await page.getByRole('textbox', { name: 'Phone country code' }).fill('+49')
  await page.getByRole('textbox', { name: 'Phone number' }).fill('30 1234567')
  await page.getByRole('textbox', { name: 'Street and number' }).fill('Hauptstr. 1')
  await page.getByRole('textbox', { name: 'Postal code' }).fill('10115')
  await page.getByRole('textbox', { name: 'City', exact: true }).fill('Berlin')
  await page.getByRole('combobox', { name: 'Country' }).selectOptions('DE')
}

async function searchAndChoose(): Promise<void> {
  await page.getByTestId('onboarding-domain-buy').click()
  await page.getByRole('textbox', { name: 'The name you want' }).fill('acme')
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('button', { name: 'Choose acme.eu' }).click()
}

describe('welcome-wizard.svelte — the Domain act, then the Email act', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.setItem('ee-voice', 'off')
    return () => {
      vi.unstubAllGlobals()
      window.localStorage.removeItem('ee-voice')
    }
  })

  it('buy path: search, yearly prices, prefilled registrant, an honest confirmation, progress, then the sender address', async () => {
    fakeOs({ states: ['', 'charging', 'registering', 'configuring', 'active'] })
    render(WelcomeWizard, MANAGED_BUY)
    await openDomainAct()
    await expect.element(page.getByText('Your company’s address on the internet.')).toBeInTheDocument()
    await expect
      .element(page.getByTestId('onboarding-have-domain'))
      .toHaveTextContent('I already have one')
    await expect.element(page.getByTestId('onboarding-domain-skip')).toBeInTheDocument()

    await page.getByTestId('onboarding-domain-buy').click()
    await page.getByRole('textbox', { name: 'The name you want' }).fill('acme')
    await page.getByRole('button', { name: 'Search' }).click()
    await expect.element(page.getByText('€12.00 / year')).toBeInTheDocument()
    await expect.element(page.getByText('Taken')).toBeInTheDocument()
    expect(callsTo('/api/domains/search?q=acme')).toHaveLength(1)

    await page.getByRole('button', { name: 'Choose acme.eu' }).click()
    // Prefilled from what os knows about the company and the owner.
    await expect.element(page.getByRole('textbox', { name: 'Company' })).toHaveValue('Acme GmbH')
    await expect.element(page.getByRole('textbox', { name: 'First name' })).toHaveValue('Ada')
    await expect.element(page.getByRole('textbox', { name: 'Email' })).toHaveValue('ada@acme.test')
    await fillRegistrant()
    await page.getByRole('button', { name: 'Continue' }).click()

    const confirm = page.getByTestId('domain-confirm')
    await expect.element(confirm.getByText(/costs €12\.00 a year/)).toBeInTheDocument()
    await expect.element(confirm.getByText(/renews every year at €12\.00/)).toBeInTheDocument()
    await expect.element(confirm.getByText(/can’t be refunded/)).toBeInTheDocument()
    expect(callsTo('/api/domains/purchases')).toHaveLength(0)

    await page.getByRole('button', { name: 'Buy for €12.00 / year' }).click()
    await vi.waitFor(() => expect(callsTo('/api/domains/purchases')).toHaveLength(1))
    expect(JSON.parse(callsTo('/api/domains/purchases')[0][1]!.body!)).toEqual({
      name: 'acme.eu',
      acceptedPriceCents: 1200,
      registrant: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        organization: 'Acme GmbH',
        email: 'ada@acme.test',
        phone: '+49.301234567',
        addressLine1: 'Hauptstr. 1',
        city: 'Berlin',
        postalCode: '10115',
        countryCode: 'DE',
      },
    })

    // Progress polls until active, then the act moves on by itself to the sender address on that domain.
    await expect.element(page.getByTestId('onboarding-mail-managed')).toBeInTheDocument()
    await expect.element(page.getByTestId('sender-domain')).toHaveTextContent('@acme.eu')
    // No keys with eigenEnterprise Mail.
    await expect.element(page.getByLabelText('Secret access key')).not.toBeInTheDocument()
    await page.getByRole('button', { name: 'Use this address' }).click()
    await expect
      .element(page.getByText('Sign-in codes and the company’s mail go out from hello@acme.eu.'))
      .toBeInTheDocument()
    expect(JSON.parse(callsTo('/api/onboarding/sender')[0][1]!.body!)).toEqual({
      address: 'hello@acme.eu',
    })
    await page.getByTestId('onboarding-continue').click()
    await expect.element(page.getByText(MIND_HEADING)).toBeInTheDocument()
  })

  it('a purchase already on its way (a reload, Settings › Domains) shows its progress instead of the choices', async () => {
    fakeOs({ states: ['registering'] })
    render(WelcomeWizard, MANAGED_BUY)
    await openDomainAct()
    await expect.element(page.getByTestId('domain-progress')).toBeInTheDocument()
    await expect.element(page.getByTestId('onboarding-domain-buy')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('domain-step-registering')).toBeInTheDocument()
    // Continuing early is fine: the sender address can be picked while it finishes.
    await page.getByTestId('onboarding-continue').click()
    await expect.element(page.getByTestId('sender-domain')).toHaveTextContent('@acme.eu')
  })

  it('a registration that fails says so in the control plane’s words and offers another name', async () => {
    fakeOs({ states: ['', 'failed'] })
    render(WelcomeWizard, MANAGED_BUY)
    await openDomainAct()
    await searchAndChoose()
    await fillRegistrant()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Buy for €12.00 / year' }).click()
    await expect.element(page.getByText(/The registry refused acme\.eu\./)).toBeInTheDocument()
    await page.getByTestId('onboarding-domain-retry').click()
    await expect.element(page.getByRole('textbox', { name: 'The name you want' })).toBeInTheDocument()
  })

  it('a price change asks again at the new price; buying then accepts that price', async () => {
    fakeOs({
      purchase: {
        status: 409,
        body: { error: 'The price changed.', reason: 'price_changed', priceCents: 1400 },
      },
    })
    render(WelcomeWizard, MANAGED_BUY)
    await openDomainAct()
    await searchAndChoose()
    await fillRegistrant()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Buy for €12.00 / year' }).click()
    await expect
      .element(page.getByText('The price of acme.eu changed to €14.00 a year. Buy it at the new price?'))
      .toBeInTheDocument()
    await expect.element(page.getByTestId('domain-confirm').getByText(/costs €14\.00 a year/)).toBeInTheDocument()
    fakeOs()
    await page.getByRole('button', { name: 'Buy for €14.00 / year' }).click()
    await vi.waitFor(() => expect(callsTo('/api/domains/purchases')).toHaveLength(2))
    expect(JSON.parse(callsTo('/api/domains/purchases')[1][1]!.body!)).toMatchObject({
      name: 'acme.eu',
      acceptedPriceCents: 1400,
    })
    await expect.element(page.getByTestId('domain-progress')).toBeInTheDocument()
  })

  it('a name taken meanwhile goes back to fresh results with the control plane’s words', async () => {
    fakeOs({
      purchase: {
        status: 409,
        body: { error: 'acme.eu was just registered by someone else.', reason: 'taken', priceCents: null },
      },
    })
    render(WelcomeWizard, MANAGED_BUY)
    await openDomainAct()
    await searchAndChoose()
    await fillRegistrant()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Buy for €12.00 / year' }).click()
    await expect
      .element(page.getByText('acme.eu was just registered by someone else.'))
      .toBeInTheDocument()
    await expect.element(page.getByTestId('domain-results')).toBeInTheDocument()
    expect(callsTo('/api/domains/search?q=acme')).toHaveLength(2)
  })

  it('have-one path: enter the domain, see its DNS records, check them, then pick the sender on it', async () => {
    fakeOs()
    render(WelcomeWizard, MANAGED_NO_BUY)
    await openDomainAct()
    // Without EE_DOMAINS_* nothing is for sale and the domain list is never read.
    await expect.element(page.getByTestId('onboarding-domain-buy')).not.toBeInTheDocument()
    expect(callsTo('/api/domains')).toHaveLength(0)

    await page.getByTestId('onboarding-have-domain').click()
    await page.getByRole('textbox', { name: 'Your domain' }).fill('acme.test')
    await page.getByRole('button', { name: 'Add' }).click()
    await expect.element(page.getByTestId('dns-record-dkim')).toBeInTheDocument()
    await expect.element(page.getByText('a1.dkim.amazonses.com')).toBeInTheDocument()
    expect(JSON.parse(callsTo('/api/domains/connected')[0][1]!.body!)).toEqual({
      name: 'acme.test',
    })

    await page.getByRole('button', { name: 'Check the records now' }).click()
    await expect.element(page.getByText(/Verified — mail can go out/)).toBeInTheDocument()
    expect(callsTo('/api/domains/connected/d-1/check')).toHaveLength(1)

    await page.getByTestId('onboarding-continue').click()
    await expect.element(page.getByTestId('sender-domain')).toHaveTextContent('@acme.test')
    // Back returns to the Domain act.
    await page.getByTestId('onboarding-back').click()
    await expect.element(page.getByTestId('onboarding-mail-domain')).toBeInTheDocument()
  })

  it('skip: the Email act says there is no domain and offers Back; Continue goes on without email', async () => {
    fakeOs()
    render(WelcomeWizard, MANAGED_BUY)
    await openDomainAct()
    await page.getByTestId('onboarding-domain-skip').click()
    const none = page.getByTestId('onboarding-mail-no-domain')
    await expect.element(none).toBeInTheDocument()
    await expect.element(none.getByText(/needs one/)).toBeInTheDocument()
    await page.getByTestId('onboarding-back').click()
    await expect.element(page.getByTestId('onboarding-domain-buy')).toBeInTheDocument()
    await page.getByTestId('onboarding-domain-skip').click()
    await page.getByTestId('onboarding-continue').click()
    await expect.element(page.getByText(MIND_HEADING)).toBeInTheDocument()
    expect(callsTo('/api/onboarding/sender')).toHaveLength(0)
  })

  it('self-hosted without domains config: only "I have a domain" (then your own Amazon SES) and skip', async () => {
    fakeOs()
    render(WelcomeWizard, {
      ...OWNER_NO_MAIL,
      domainSetup: { managedMail: false, canBuy: false, registrant: null },
    })
    await openDomainAct()
    await expect.element(page.getByTestId('onboarding-domain-buy')).not.toBeInTheDocument()
    await expect
      .element(page.getByTestId('onboarding-have-domain'))
      .toHaveTextContent('I have a domain and DNS access')
    expect(callsTo('/api/domains')).toHaveLength(0)
    await page.getByTestId('onboarding-domain-skip').click()
    await expect.element(page.getByTestId('onboarding-mail-no-domain')).toBeInTheDocument()
    await page.getByTestId('onboarding-back').click()
    await page.getByTestId('onboarding-have-domain').click()
    await expect.element(page.getByLabelText('Secret access key')).toBeInTheDocument()
  })
})
