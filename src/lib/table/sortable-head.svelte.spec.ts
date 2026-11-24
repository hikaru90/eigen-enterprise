import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import Harness from './sortable-head-harness.svelte'

const order = () => [...document.querySelectorAll('td')].map((c) => c.textContent)

describe('sortable-head', () => {
  it('cycles aria-sort ascending, descending, none on click', async () => {
    render(Harness)
    const th = page.getByRole('columnheader', { name: 'Name' })
    const btn = page.getByRole('button', { name: /Name/ })
    await expect.element(th).toHaveAttribute('aria-sort', 'none')
    await btn.click()
    await expect.element(th).toHaveAttribute('aria-sort', 'ascending')
    await btn.click()
    await expect.element(th).toHaveAttribute('aria-sort', 'descending')
    await btn.click()
    await expect.element(th).toHaveAttribute('aria-sort', 'none')
  })
  it('sorts the rows and restores the original order on the third click', async () => {
    render(Harness)
    const btn = page.getByRole('button', { name: /Name/ })
    expect(order()).toEqual(['b', 'c', 'a'])
    await btn.click()
    expect(order()).toEqual(['a', 'b', 'c'])
    await btn.click()
    expect(order()).toEqual(['c', 'b', 'a'])
    await btn.click()
    expect(order()).toEqual(['b', 'c', 'a'])
  })
  it('moves sorting to another column', async () => {
    render(Harness)
    await page.getByRole('button', { name: /Name/ }).click()
    await page.getByRole('button', { name: /Other/ }).click()
    await expect
      .element(page.getByRole('columnheader', { name: 'Name' }))
      .toHaveAttribute('aria-sort', 'none')
    await expect
      .element(page.getByRole('columnheader', { name: 'Other' }))
      .toHaveAttribute('aria-sort', 'ascending')
  })
})
