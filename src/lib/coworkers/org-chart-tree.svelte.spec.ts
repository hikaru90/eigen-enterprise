import type { OrgPerson } from './org-tree'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import OrgChartTree from './org-chart-tree.svelte'

/**
 * The org chart tree (plan/phase-ai-coworkers.md C5): seats nested under the
 * person they report to, the AI mark + model family for co-workers, and
 * "Edit seat" only where this person may edit (org.set_position). Real Svelte
 * in a real browser; form posts are caught at the submit event.
 */

const seat = (id: string, over: Partial<OrgPerson> = {}): OrgPerson => ({
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

const people: OrgPerson[] = [
  seat('olga', { name: 'Olga Owner', role: 'owner', title: 'CEO' }),
  seat('ony', { name: 'Ony', reportsToUserId: 'olga', title: 'Ops' }),
  seat('mara', {
    name: 'Mara',
    kind: 'coworker',
    reportsToUserId: 'olga',
    title: 'Marketing Manager',
    accountabilities: ['Pipeline', 'Launches'],
    enabled: true,
    modelId: 'anthropic/claude-sonnet-5.5',
  }),
  seat('dana', {
    name: 'Dana',
    kind: 'coworker',
    reportsToUserId: 'mara',
    title: 'Designer',
    enabled: false,
    modelId: 'qwen/qwen3.8-flash',
  }),
]

type Submitted = { action: string; fields: Record<string, string | string[]> }
let submitted: Submitted[] = []
function catchSubmits(event: SubmitEvent) {
  event.preventDefault()
  const form = event.target as HTMLFormElement
  const fd = new FormData(form, event.submitter)
  const fields: Record<string, string | string[]> = {}
  for (const k of new Set(fd.keys())) {
    const all = fd.getAll(k).map(String)
    fields[k] = k === 'reports_to_user_ids' ? all : all.length > 1 ? all : all[0]!
  }
  submitted.push({ action: form.getAttribute('action') ?? '', fields })
}
beforeEach(() => {
  submitted = []
  document.addEventListener('submit', catchSubmits, true)
})
afterEach(() => document.removeEventListener('submit', catchSubmits, true))

const seatEl = (id: string) =>
  document.querySelector(`[data-testid="org-seat"][data-id="${id}"]`) as HTMLElement

describe('org-chart-tree.svelte', () => {
  it('nests each seat under its manager, as lists screen readers announce by level', async () => {
    render(OrgChartTree, { people, me: { id: 'ony', canManage: false } })
    await expect.element(page.getByRole('list', { name: 'Org chart' })).toBeInTheDocument()
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
    await expect.element(page.getByRole('list', { name: 'Reports to Mara' })).toBeInTheDocument()
  })

  it('a co-worker shows the AI mark with its model family, its accountabilities, and whether it is off', async () => {
    render(OrgChartTree, { people, me: { id: 'ony', canManage: false } })
    const mara = seatEl('mara')
    const mark = mara.querySelector('[data-testid="ai-mark"]')!
    expect(mark.getAttribute('data-family')).toBe('Anthropic')
    expect(mark.textContent).toContain('AI')
    await expect
      .element(page.getByRole('list', { name: 'Accountabilities of Mara' }))
      .toHaveTextContent('PipelineLaunches')
    expect(seatEl('dana').querySelector('[data-testid="org-seat-off"]')?.textContent).toBe('Off')
    expect(seatEl('ony').querySelector('[data-testid="ai-mark"]')).toBeNull()
  })

  it('each name links to the seat profile', async () => {
    render(OrgChartTree, { people, me: { id: 'ony', canManage: false } })
    await expect
      .element(page.getByRole('link', { name: 'Mara', exact: true }))
      .toHaveAttribute('href', expect.stringContaining('/settings/org/'))
  })

  it("every seat has a visible Profile link next to Edit (the profile holds a co-worker's runs and Would pick up)", async () => {
    render(OrgChartTree, { people, me: { id: 'ony', canManage: false } })
    expect(document.querySelectorAll('[data-testid="org-seat-profile"]')).toHaveLength(
      people.length,
    )
    const profile = seatEl('mara').querySelector('[data-testid="org-seat-profile"]')!
    expect(profile.tagName).toBe('A')
    expect(profile.textContent).toBe('Profile: Mara')
    expect(profile.getAttribute('href')).toBe(
      seatEl('mara').querySelector('[data-testid="org-seat-name"]')!.getAttribute('href'),
    )
  })

  it('a member may edit only their own seat: title and accountabilities, no reports-to', async () => {
    render(OrgChartTree, { people, me: { id: 'ony', canManage: false } })
    expect(document.querySelectorAll('[data-testid="org-seat-edit"]')).toHaveLength(1)
    const edit = page.getByRole('button', { name: 'Edit seat: Ony' })
    await expect.element(edit).toHaveAttribute('aria-expanded', 'false')
    await edit.click()
    await expect.element(edit).toHaveAttribute('aria-expanded', 'true')
    expect(seatEl('ony').querySelector('[data-testid="org-seat-manager"]')).toBeNull()
    await userEvent.fill(page.getByLabelText('Title', { exact: true }), 'Operations Lead')
    await userEvent.fill(
      page.getByLabelText('Accountabilities', { exact: true }),
      'Payroll\nVendors',
    )
    await page.getByTestId('org-seat-save').click()
    expect(submitted).toEqual([
      {
        action: '?/setPosition',
        fields: { user_id: 'ony', title: 'Operations Lead', accountabilities: 'Payroll\nVendors' },
      },
    ])
  })

  it('an admin edits anyone, multi-manager reports-to included, and is never offered a seat below the one edited', async () => {
    render(OrgChartTree, { people, me: { id: 'olga', canManage: true } })
    expect(document.querySelectorAll('[data-testid="org-seat-edit"]')).toHaveLength(4)
    await page.getByRole('button', { name: 'Edit seat: Mara' }).click()
    const fieldset = page.getByTestId('org-seat-manager')
    const options = [...fieldset.element().querySelectorAll('label')].map((l) => l.textContent?.trim())
    expect(options).toEqual(['Olga Owner', 'Ony'])
    await fieldset.getByRole('checkbox', { name: 'Ony' }).click()
    await page.getByTestId('org-seat-save').click()
    expect(submitted[0]!.fields).toMatchObject({
      user_id: 'mara',
      reports_to_sent: '1',
      reports_to_user_ids: ['olga', 'ony'],
      title: 'Marketing Manager',
    })
  })

  it('renders seat avatar images and secondary manager badges for multi-manager seats', async () => {
    const multi = people.map((p) =>
      p.id === 'dana'
        ? { ...p, image: '/avatars/coworkers/prism.svg', reportsToUserIds: ['mara', 'ony'] }
        : p,
    )
    render(OrgChartTree, { people: multi, me: { id: 'olga', canManage: true } })
    const dana = seatEl('dana')
    expect(dana.querySelector('[data-testid="org-seat-avatar"] img')?.getAttribute('src')).toBe('/avatars/coworkers/prism.svg')
    expect(dana.querySelector('[data-testid="org-seat-also-reports"]')?.textContent).toContain('Ony')
    // Ony is a secondary manager of Dana, so Ony cannot report to Dana.
    await page.getByRole('button', { name: 'Edit seat: Ony' }).click()
    const onyOptions = [...page.getByTestId('org-seat-manager').element().querySelectorAll('label')].map((l) => l.textContent?.trim())
    expect(onyOptions).toEqual(['Olga Owner', 'Mara (AI)'])
  })

  it('shows a waiting-for-approval answer under the seat it is about', async () => {
    render(OrgChartTree, {
      people,
      me: { id: 'ony', canManage: false },
      form: { action: 'setPosition', waiting: true, userId: 'ony' },
    })
    const fb = seatEl('ony').querySelector('[data-testid="org-seat-feedback"]')!
    expect(fb.getAttribute('data-kind')).toBe('waiting')
    expect(fb.textContent).toContain('Waiting for approval')
    expect(seatEl('mara').querySelector('[data-testid="org-seat-feedback"]')).toBeNull()
  })
})
