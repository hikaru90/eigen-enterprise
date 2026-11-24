import type { OrgPerson } from './org-tree'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import OrgDiagram from './org-diagram.svelte'

type DiagramPerson = OrgPerson & { image?: string | null; reportsToUserIds?: string[] }

const AVATAR_DATA_URL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const seat = (id: string, over: Partial<DiagramPerson> = {}): DiagramPerson => ({
  id,
  name: id,
  kind: 'human',
  role: 'member',
  title: null,
  accountabilities: [],
  reportsToUserId: null,
  accountableHuman: null,
  enabled: null,
  modelId: null,
  ...over,
})

const people: DiagramPerson[] = [
  seat('olga', { name: 'Olga Owner', role: 'owner', title: 'CEO', image: AVATAR_DATA_URL }),
  seat('ony', { name: 'Ony', reportsToUserId: 'olga', title: 'Ops' }),
  seat('mara', {
    id: 'mara',
    name: 'Mara',
    kind: 'coworker',
    reportsToUserId: 'olga',
    title: 'Marketing Manager',
    accountabilities: ['Pipeline', 'Launches', 'Messaging', 'Analytics'],
    enabled: true,
    modelId: 'anthropic/claude-sonnet-5.5',
  }),
  seat('dana', {
    name: 'Dana',
    kind: 'coworker',
    reportsToUserId: 'mara',
    reportsToUserIds: ['mara', 'ony'],
    title: 'Designer',
    enabled: false,
    modelId: 'qwen/qwen3.8-flash',
  }),
]

type Submitted = { action: string; fields: Record<string, string> }
let submitted: Submitted[] = []
function catchSubmits(event: SubmitEvent) {
  event.preventDefault()
  const form = event.target as HTMLFormElement
  const fields: Record<string, string> = {}
  for (const [k, v] of new FormData(form, event.submitter).entries()) fields[k] = String(v)
  submitted.push({ action: form.getAttribute('action') ?? '', fields })
}
beforeEach(() => {
  submitted = []
  document.addEventListener('submit', catchSubmits, true)
})
afterEach(() => document.removeEventListener('submit', catchSubmits, true))

const seatEl = (id: string) =>
  document.querySelector(`[data-testid="org-seat"][data-id="${id}"]`) as HTMLElement

describe('org-diagram.svelte', () => {
  it('defaults to Diagram view, nests seats hierarchically, and places connector stems under managers', async () => {
    render(OrgDiagram, { people, me: { id: 'ony', canManage: false } })
    await expect.element(page.getByTestId('org-diagram')).toBeInTheDocument()
    await expect.element(page.getByTestId('org-tree')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('org-view-diagram')).toHaveAttribute('aria-pressed', 'true')
    await expect.element(page.getByTestId('org-view-list')).toHaveAttribute('aria-pressed', 'false')

    await expect.element(page.getByRole('list', { name: 'Org chart' })).toBeInTheDocument()
    await expect.element(page.getByRole('list', { name: 'Reports to Olga Owner' })).toBeInTheDocument()
    await expect.element(page.getByRole('list', { name: 'Reports to Mara' })).toBeInTheDocument()

    expect(
      [...document.querySelectorAll('[data-testid="org-seat"]')].map((e) => [
        e.getAttribute('data-id'),
        e.getAttribute('data-depth'),
      ]),
    ).toEqual([
      ['olga', '0'],
      ['ony', '1'],
      ['mara', '1'],
      ['dana', '2'],
    ])

    expect(seatEl('olga').querySelector(':scope > [data-testid="org-connector-stem"]')).not.toBeNull()
    expect(seatEl('mara').querySelector(':scope > [data-testid="org-connector-stem"]')).not.toBeNull()
    expect(seatEl('ony').querySelector(':scope > [data-testid="org-connector-stem"]')).toBeNull()
    expect(seatEl('dana').querySelector(':scope > [data-testid="org-connector-stem"]')).toBeNull()
  })

  it('renders UserAvatar, name links, AI model badges, Off status, accountabilities preview, and Profile buttons', async () => {
    render(OrgDiagram, { people, me: { id: 'ony', canManage: false } })

    const olgaAvatar = seatEl('olga').querySelector(':scope > article [data-testid="org-seat-avatar"]')!
    expect(olgaAvatar.getAttribute('data-has-image')).toBe('true')
    expect(olgaAvatar.querySelector('img')?.getAttribute('src')).toBe(AVATAR_DATA_URL)

    const onyAvatar = seatEl('ony').querySelector(':scope > article [data-testid="org-seat-avatar"]')!
    expect(onyAvatar.getAttribute('data-has-image')).toBe('false')
    expect(onyAvatar.textContent).toBe('O')

    const mara = seatEl('mara')
    const mark = mara.querySelector(':scope > article [data-testid="ai-mark"]')!
    expect(mark.getAttribute('data-family')).toBe('Anthropic')
    expect(mark.textContent).toContain('AI')
    await expect
      .element(page.getByRole('list', { name: 'Accountabilities of Mara' }))
      .toHaveTextContent('PipelineLaunchesMessaging')
    expect(mara.querySelector(':scope > article')?.textContent).toContain('+1 more')

    expect(seatEl('dana').querySelector(':scope > article [data-testid="ai-mark"]')?.getAttribute('data-family')).toBe('Qwen')
    expect(seatEl('dana').querySelector(':scope > article [data-testid="org-seat-off"]')?.textContent).toBe('Off')
    expect(seatEl('ony').querySelector(':scope > article [data-testid="ai-mark"]')).toBeNull()

    for (const id of ['olga', 'ony', 'mara', 'dana']) {
      const nameLink = seatEl(id).querySelector(':scope > article [data-testid="org-seat-name"]')!
      const profileBtn = seatEl(id).querySelector(':scope > article [data-testid="org-seat-profile"]')!
      expect(nameLink.getAttribute('href')).toContain('/settings/org/')
      expect(profileBtn.getAttribute('href')).toBe(nameLink.getAttribute('href'))
    }
  })

  it('handles optional reportsToUserIds defensively and shows secondary managers when present', async () => {
    render(OrgDiagram, { people, me: { id: 'ony', canManage: false } })
    expect(seatEl('mara').querySelector(':scope > article [data-testid="org-seat-extra-managers"]')).toBeNull()
    expect(seatEl('dana').querySelector(':scope > article [data-testid="org-seat-extra-managers"]')?.textContent).toContain('Ony')
  })

  it('toggles cleanly between Diagram and List (OrgChartTree) views', async () => {
    render(OrgDiagram, { people, me: { id: 'ony', canManage: false } })
    await page.getByTestId('org-view-list').click()
    await expect.element(page.getByTestId('org-tree')).toBeInTheDocument()
    await expect.element(page.getByTestId('org-diagram')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('org-view-list')).toHaveAttribute('aria-pressed', 'true')
    await expect.element(page.getByTestId('org-view-diagram')).toHaveAttribute('aria-pressed', 'false')

    await page.getByTestId('org-view-diagram').click()
    await expect.element(page.getByTestId('org-diagram')).toBeInTheDocument()
    await expect.element(page.getByTestId('org-tree')).not.toBeInTheDocument()
  })

  it('a member edits only their own seat without reports-to; an admin edits anyone including reports-to', async () => {
    const view = render(OrgDiagram, { people, me: { id: 'ony', canManage: false } })
    expect(document.querySelectorAll('[data-testid="org-seat-edit"]')).toHaveLength(1)
    const edit = page.getByRole('button', { name: 'Edit seat: Ony' })
    await expect.element(edit).toHaveAttribute('aria-expanded', 'false')
    await edit.click()
    await expect.element(edit).toHaveAttribute('aria-expanded', 'true')
    expect(seatEl('ony').querySelector('[data-testid="org-seat-manager"]')).toBeNull()

    await userEvent.fill(page.getByLabelText('Title', { exact: true }), 'Operations Lead')
    await userEvent.fill(page.getByLabelText('Accountabilities', { exact: true }), 'Payroll\nVendors')
    await page.getByTestId('org-seat-save').click()
    expect(submitted).toEqual([
      {
        action: '?/setPosition',
        fields: { user_id: 'ony', title: 'Operations Lead', accountabilities: 'Payroll\nVendors' },
      },
    ])

    view.unmount()
    submitted = []
    render(OrgDiagram, { people, me: { id: 'olga', canManage: true } })
    expect(document.querySelectorAll('[data-testid="org-seat-edit"]')).toHaveLength(4)
    await page.getByRole('button', { name: 'Edit seat: Mara' }).click()
    const select = page.getByLabelText('Reports to', { exact: true })
    const options = [...(select.element() as HTMLSelectElement).options].map((o) => o.textContent)
    expect(options).toEqual(['Nobody', 'Olga Owner', 'Ony'])
    await userEvent.selectOptions(select, 'Ony')
    await page.getByTestId('org-seat-save').click()
    expect(submitted[0]!.fields).toMatchObject({
      user_id: 'mara',
      reports_to_user_id: 'ony',
      title: 'Marketing Manager',
    })
  })

  it('shows waiting and error feedback under the matching seat card', async () => {
    const view = render(OrgDiagram, {
      people,
      me: { id: 'ony', canManage: false },
      form: { action: 'setPosition', waiting: true, userId: 'ony' },
    })
    const fb = seatEl('ony').querySelector('[data-testid="org-seat-feedback"]')!
    expect(fb.getAttribute('data-kind')).toBe('waiting')
    expect(fb.textContent).toContain('Waiting for approval')
    expect(seatEl('mara').querySelector('[data-testid="org-seat-feedback"]')).toBeNull()

    view.unmount()
    render(OrgDiagram, {
      people,
      me: { id: 'olga', canManage: true },
      form: {
        action: 'setPosition',
        userId: 'mara',
        error: 'Mara cannot report to someone who reports to Mara.',
      },
    })
    const errFb = seatEl('mara').querySelector(':scope > article [data-testid="org-seat-feedback"]')!
    expect(errFb.getAttribute('data-slot')).toBe('error-notice')
    expect(errFb.querySelector('[role="alert"]')?.textContent).toContain(
      'Mara cannot report to someone who reports to Mara.',
    )
  })

  it('shows empty state when people is empty', async () => {
    render(OrgDiagram, { people: [], me: { id: 'olga', canManage: true } })
    await expect.element(page.getByTestId('org-empty')).toBeInTheDocument()
  })
})
