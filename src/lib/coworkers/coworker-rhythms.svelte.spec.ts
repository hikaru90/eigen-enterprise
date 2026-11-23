import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import CoworkerRhythms from './coworker-rhythms.svelte'

/**
 * A co-worker's rhythms in Settings → Co-workers (plan/phase-ai-coworkers.md
 * C6): each rhythm's schedule, where it posts (or that it is somewhere you are
 * not) and what; run now, pause, edit and delete post their form actions; a
 * new rhythm starts on workdays at 09:00 in your zone and picks where it posts
 * from the conversations the co-worker is in.
 */

const rhythm = {
  id: 'r1',
  weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'] as ('MO' | 'TU' | 'WE' | 'TH' | 'FR')[],
  time: '09:00',
  timeZone: 'Europe/Berlin',
  instruction: 'Post the marketing standup.',
  targetConversationId: 'c1',
  targetTitle: '#marketing',
  hidden: false,
  enabled: true,
  nextAt: '2026-11-24T08:00:00.000Z',
}
const targets = [{ id: 'c1', title: '#marketing', kind: 'channel' as const }]

const formOf = (testid: string) => page.getByTestId(testid).element().closest('form')!

describe('CoworkerRhythms', () => {
  it('shows the rhythm and posts run now, pause and delete (after naming it) to their actions', async () => {
    render(CoworkerRhythms, { coworkerId: 'cw1', coworkerName: 'Mara', rhythms: [rhythm], targets, timeZone: 'Europe/Berlin' })
    await expect.element(page.getByTestId('rhythm-schedule')).toHaveTextContent('Weekdays · 09:00 · Europe/Berlin')
    await expect.element(page.getByTestId('rhythm-where')).toHaveTextContent(/in #marketing/)
    await expect.element(page.getByTestId('rhythm-instruction')).toHaveTextContent('Post the marketing standup.')
    expect(formOf('rhythm-run-now').getAttribute('action')).toBe('?/rhythmRunNow')
    const pause = formOf('rhythm-toggle')
    expect(pause.getAttribute('action')).toBe('?/rhythmUpdate')
    expect(new FormData(pause).get('enabled')).toBe('false')
    await expect.element(page.getByTestId('rhythm-toggle')).toHaveTextContent('Pause')
    await userEvent.click(page.getByTestId('rhythm-delete'))
    const del = formOf('rhythm-delete-confirm')
    expect(del.getAttribute('action')).toBe('?/rhythmDelete')
    expect(Object.fromEntries(new FormData(del))).toEqual({ user_id: 'cw1', rhythm_id: 'r1' })
  })

  it('a rhythm in a conversation you are not in says so; a paused one offers Resume', async () => {
    render(CoworkerRhythms, {
      coworkerId: 'cw1',
      coworkerName: 'Mara',
      rhythms: [{ ...rhythm, hidden: true, targetConversationId: null, targetTitle: null, enabled: false, nextAt: null }],
      targets,
      timeZone: 'Europe/Berlin',
    })
    await expect.element(page.getByTestId('rhythm-where')).toHaveTextContent("in a conversation you're not in · Paused")
    await expect.element(page.getByTestId('rhythm-toggle')).toHaveTextContent('Resume')
  })

  it('a new rhythm: workdays at 09:00 in your zone, a conversation it is in, what to post', async () => {
    render(CoworkerRhythms, { coworkerId: 'cw1', coworkerName: 'Mara', rhythms: [], targets, timeZone: 'America/New_York' })
    await expect.element(page.getByTestId('rhythms-empty')).toBeInTheDocument()
    await userEvent.click(page.getByTestId('rhythm-add'))
    const form = formOf('rhythm-create')
    expect(form.getAttribute('action')).toBe('?/rhythmCreate')
    await userEvent.selectOptions(page.getByTestId('rhythm-new-cw1-where'), 'c1')
    await userEvent.fill(page.getByTestId('rhythm-new-cw1-instruction'), 'Post the weekly numbers.')
    const data = new FormData(form)
    expect(data.getAll('weekdays')).toEqual(['MO', 'TU', 'WE', 'TH', 'FR'])
    expect(Object.fromEntries([...data].filter(([k]) => k !== 'weekdays'))).toEqual({
      user_id: 'cw1',
      weekdays_sent: '1',
      time: '09:00',
      time_zone: 'America/New_York',
      conversation_id: 'c1',
      instruction: 'Post the weekly numbers.',
    })
  })

  it('with no conversation to post in, it says to add the co-worker to a channel first', async () => {
    render(CoworkerRhythms, { coworkerId: 'cw1', coworkerName: 'Mara', rhythms: [], targets: [], timeZone: 'Europe/Berlin' })
    await userEvent.click(page.getByTestId('rhythm-add'))
    await expect.element(page.getByTestId('rhythm-no-targets')).toBeInTheDocument()
  })

  it('after run now it says the post is on its way; a refusal shows its sentence', async () => {
    const { rerender } = render(CoworkerRhythms, {
      coworkerId: 'cw1',
      coworkerName: 'Mara',
      rhythms: [rhythm],
      targets,
      timeZone: 'Europe/Berlin',
      form: { action: 'rhythmRunNow', ok: true, userId: 'cw1' },
    })
    await expect.element(page.getByTestId('rhythm-queued')).toBeInTheDocument()
    await rerender({ form: { action: 'rhythmCreate', userId: 'cw1', error: 'Mara is not a member of that conversation.', agent: { tool: 'coworkers.rhythm_create' } } })
    await expect.element(page.getByText('Mara is not a member of that conversation.')).toBeInTheDocument()
  })
})
