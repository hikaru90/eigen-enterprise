import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import MaterialWorkbench from './material-workbench.svelte'

describe('brand material: workbench', () => {
  const mounted: Array<() => void> = []
  afterEach(() => {
    for (const unmount of mounted.reverse()) unmount()
    mounted.length = 0
  })

  const style = {
    name: 'Blueprint',
    cssVars: { '--primary': 'rgb(255, 0, 0)' },
    darkCssVars: { '--primary': 'rgb(0, 255, 0)' },
  }

  function setup() {
    const r = render(MaterialWorkbench, { style })
    mounted.push(r.unmount)
    return r
  }

  it('opens on the digital flyer, every kind selectable (none "Coming")', async () => {
    setup()
    await expect.element(page.getByTestId('flyer')).toBeVisible()
    for (const label of ['Digital flyer', 'Banner', 'Trade-show poster', 'Merch'])
      await expect.element(page.getByRole('button', { name: label, exact: true })).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Digital flyer', exact: true }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(document.body.textContent).not.toContain('Coming')
  })

  it('banner: social header first, then the roll-up; the size is shown', async () => {
    setup()
    await page.getByRole('button', { name: 'Banner', exact: true }).click()
    await expect.element(page.getByTestId('banner')).toHaveAttribute('data-format', 'banner-social')
    await expect.element(page.getByTestId('material-size')).toHaveTextContent('1500 × 500 px')
    await page.getByRole('button', { name: /Roll-up banner/ }).click()
    await expect.element(page.getByTestId('banner')).toHaveAttribute('data-format', 'banner-rollup')
    await expect.element(page.getByTestId('material-size')).toHaveTextContent('850 × 2000 mm')
    expect(document.querySelector('[data-testid="flyer"]')).toBeNull()
  })

  it('poster defaults to A1; the copy typed in carries over between kinds', async () => {
    setup()
    await page.getByLabelText('Headline').fill('Hall 3, booth 12')
    await expect.element(page.getByTestId('flyer')).toHaveTextContent(/Hall 3, booth 12/)
    await page.getByRole('button', { name: 'Trade-show poster', exact: true }).click()
    await expect.element(page.getByTestId('poster')).toHaveAttribute('data-format', 'poster-a1')
    await expect.element(page.getByTestId('poster')).toHaveTextContent(/Hall 3, booth 12/)
  })

  it('merch takes only a slogan: text and button fields are hidden', async () => {
    setup()
    await page.getByRole('button', { name: 'Merch', exact: true }).click()
    await expect.element(page.getByTestId('merch')).toHaveAttribute('data-format', 'merch-shirt')
    await expect.element(page.getByLabelText('Slogan')).toBeVisible()
    expect(document.getElementById('material-body')).toBeNull()
    expect(document.getElementById('material-cta')).toBeNull()
    await page.getByRole('button', { name: /Mug wrap/ }).click()
    await expect.element(page.getByTestId('merch')).toHaveAttribute('data-format', 'merch-mug')
  })

  it('the theme switch drives the preview', async () => {
    setup()
    await page.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect.element(page.getByTestId('flyer')).toHaveAttribute('data-system-theme', 'dark')
  })
})
