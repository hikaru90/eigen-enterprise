import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import MemberRow from './member-row.svelte'

/**
 * Settings → Members rows (plan/phase-ai-coworkers.md C5): a person has the
 * role and remove controls; an AI co-worker carries the AI mark and leads to
 * Settings → Co-workers instead — no dead role or remove buttons (the tools
 * refuse co-workers anyway).
 */

const person = { id: 'bea', name: 'Bea', email: 'bea@k.test', role: 'member' as const, kind: 'human' as const, image: null }
const coworker = { id: 'cw1', name: 'Mara', email: 'mara.cw1@coworker.invalid', role: 'member' as const, kind: 'coworker' as const, image: null }

describe('member-row.svelte', () => {
  it('a co-worker: AI mark, a link to Settings → Co-workers, no role or remove control, no made-up address', async () => {
    render(MemberRow, { member: coworker, meId: 'olga' })
    await expect.element(page.getByTestId('member-row')).toHaveAttribute('data-kind', 'coworker')
    await expect.element(page.getByTestId('ai-mark')).toBeVisible()
    await expect.element(page.getByRole('link', { name: 'Managed in Co-workers' })).toHaveAttribute('href', '/settings/coworkers')
    expect(page.getByTestId('member-role-select').elements()).toHaveLength(0)
    expect(page.getByTestId('member-remove').elements()).toHaveLength(0)
    expect(page.getByText('coworker.invalid').elements()).toHaveLength(0)
  })

  it('a person: role select and remove, no AI mark', async () => {
    render(MemberRow, { member: person, meId: 'olga' })
    await expect.element(page.getByTestId('member-role-select')).toBeInTheDocument()
    await expect.element(page.getByTestId('member-remove')).toBeInTheDocument()
    await expect.element(page.getByText('bea@k.test', { exact: true })).toBeInTheDocument()
    expect(page.getByTestId('ai-mark').elements()).toHaveLength(0)
  })

  it('no remove control on your own row', async () => {
    render(MemberRow, { member: person, meId: 'bea' })
    await expect.element(page.getByTestId('member-role-select')).toBeInTheDocument()
    expect(page.getByTestId('member-remove').elements()).toHaveLength(0)
  })
})
