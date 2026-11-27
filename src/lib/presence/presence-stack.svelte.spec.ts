import type { PresencePerson } from './company-presence.svelte'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import PresenceStack from './presence-stack.svelte'

const person = (userId: string, name: string, place: string | null, status: PresencePerson['presence']['status'] = 'online'): PresencePerson => ({
  userId,
  name,
  image: null,
  presence: { userId, status, doNotDisturb: status === 'dnd', lastSeenAt: null },
  where: { area: 'drive', path: null, item: null },
  place,
  label: place ? `${name} · ${place}` : name,
})

const four = [
  person('anna', 'Anna Müller', 'Q4 plan.xlsx'),
  person('ben', 'Ben Ode', 'Drive', 'away'),
  person('cara', 'Cara Lin', 'Drive', 'in_call'),
  person('dan', 'Dan Roe', 'Drive'),
]

describe('presence-stack.svelte (who is here — small round avatars)', () => {
  it('shows up to three avatars and +n for the rest; its name lists everyone and what they have open', async () => {
    render(PresenceStack, { people: four, title: 'In Drive', testid: 'stack' })
    const stack = page.getByTestId('stack')
    await expect.element(stack).toHaveAccessibleName(
      'In Drive: Anna Müller · Q4 plan.xlsx, Ben Ode · Drive (Away), Cara Lin · Drive (In a call), Dan Roe · Drive',
    )
    expect(stack.getByTestId('stack-avatar').all()).toHaveLength(3)
    await expect.element(stack.getByTestId('stack-more')).toHaveTextContent('+1')
  })

  it('a status dot only where the status is worth telling (away, in a call, do not disturb)', async () => {
    render(PresenceStack, { people: four.slice(0, 3), title: 'In Drive', testid: 'stack' })
    const dots = page.getByTestId('stack').getByTestId('stack-dot')
    expect(dots.all().map((d) => d.element().getAttribute('data-status'))).toEqual(['away', 'in_call'])
    await expect.element(page.getByTestId('stack-more')).not.toBeInTheDocument()
  })

  it('hover lists names and what each has open', async () => {
    render(PresenceStack, { people: four, title: 'In Drive', testid: 'stack' })
    await userEvent.hover(page.getByTestId('stack'))
    const list = page.getByTestId('stack-list')
    await expect.element(list).toBeVisible()
    await expect.element(list).toHaveTextContent('In Drive')
    await expect.element(list).toHaveTextContent('Anna Müller')
    await expect.element(list).toHaveTextContent('Q4 plan.xlsx')
    await expect.element(list).toHaveTextContent('Dan Roe')
  })

  it('keyboard focus opens the list too', async () => {
    render(PresenceStack, { people: four.slice(0, 1), title: 'Here with you', testid: 'stack' })
    await userEvent.tab()
    await expect.element(page.getByTestId('stack')).toHaveFocus()
    await expect.element(page.getByTestId('stack-list')).toBeVisible()
  })
})
