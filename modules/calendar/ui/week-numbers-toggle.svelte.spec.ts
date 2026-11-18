import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import WeekNumbersToggle from './week-numbers-toggle.svelte'

/** The switch inside the page's form: what a click posts. */
function mount(on: boolean): Promise<FormDataEntryValue | null> {
  return new Promise((resolve) => {
    const form = document.createElement('form')
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      resolve(new FormData(form, e.submitter).get('weekNumbers'))
    })
    document.body.append(form)
    render(WeekNumbersToggle, { target: form, props: { on } })
  })
}

describe('week-numbers-toggle.svelte', () => {
  it('a switch, off: turning it on posts weekNumbers=on', async () => {
    const sent = mount(false)
    const toggle = page.getByRole('switch', { name: 'Show week numbers' }).last()
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    expect(await sent).toBe('on')
  })

  it('on: shown as on, and turning it off posts weekNumbers=off', async () => {
    const sent = mount(true)
    const toggle = page.getByRole('switch', { name: 'Show week numbers' }).last()
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    expect(await sent).toBe('off')
  })
})
