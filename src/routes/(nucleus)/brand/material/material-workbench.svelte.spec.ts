import type { MaterialApi } from './material-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { BrandRequestError } from '../brand-errors'
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
    const r = render(MaterialWorkbench, { style, logoUrl: null })
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

describe('brand material: export, logo and AI texts', () => {
  const mounted: Array<() => void> = []
  afterEach(() => {
    for (const unmount of mounted.reverse()) unmount()
    mounted.length = 0
  })

  const style = { name: 'Blueprint', cssVars: { '--primary': 'rgb(255, 0, 0)' }, darkCssVars: null }
  const logoUrl =
    'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>')

  function fakeApi(over: Partial<MaterialApi> = {}): MaterialApi {
    return {
      exportFile: vi.fn(async () => ({ blob: new Blob(['%PDF']), filename: 'your-headline-flyer-a5.pdf' })),
      suggestTexts: vi.fn(async () => ({
        formatId: 'flyer-a5',
        locale: 'de',
        voice: true,
        variants: [1, 2, 3].map((n) => ({ headline: `Kopf ${n}`, body: `Text ${n}`, cta: `Los ${n}` })),
      })),
      ...over,
    }
  }

  function setup(props: { api?: MaterialApi; logoUrl?: string | null } = {}) {
    const api = props.api ?? fakeApi()
    const save = vi.fn()
    const r = render(MaterialWorkbench, { style, logoUrl: props.logoUrl ?? null, api, save })
    mounted.push(r.unmount)
    return { api, save }
  }

  it('downloads the flyer as a print-ready PDF with the copy as typed and the logo on', async () => {
    const { api, save } = setup({ logoUrl })
    await expect.element(page.getByTestId('material-export-hint')).toHaveTextContent('Print-ready PDF, 148 × 210 mm')
    await page.getByLabelText('Headline').fill('Hall 3')
    await page.getByRole('button', { name: 'Download PDF' }).click()
    expect(api.exportFile).toHaveBeenCalledWith({
      formatId: 'flyer-a5',
      mode: 'light',
      headline: 'Hall 3',
      body: 'One or two sentences about what you are announcing.',
      cta: 'Find out more',
      logo: true,
    })
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.any(Blob), 'your-headline-flyer-a5.pdf'))
  })

  it('the social header and merch download as PNG; merch sends its slogan only', async () => {
    const { api } = setup()
    await page.getByRole('button', { name: 'Banner', exact: true }).click()
    await expect.element(page.getByTestId('material-export-hint')).toHaveTextContent('PNG, 1500 × 500 px')
    await page.getByRole('button', { name: 'Merch', exact: true }).click()
    await expect.element(page.getByTestId('material-export-hint')).toHaveTextContent('PNG, 3543 × 4724 px')
    await page.getByRole('button', { name: 'Download PNG' }).click()
    expect(api.exportFile).toHaveBeenCalledWith({ formatId: 'merch-shirt', mode: 'light', headline: 'Your headline', logo: false })
  })

  it('places the company logo on the preview; switched off, the style mark comes back', async () => {
    const { api } = setup({ logoUrl })
    await expect.element(page.getByTestId('flyer').getByTestId('material-logo')).toBeVisible()
    await page.getByLabelText('Company logo').click()
    expect(document.querySelector('[data-testid="material-logo"]')).toBeNull()
    await expect.element(page.getByTestId('flyer')).toHaveTextContent(/Blueprint/)
    await page.getByRole('button', { name: 'Download PDF' }).click()
    expect(api.exportFile).toHaveBeenCalledWith(expect.objectContaining({ logo: false }))
  })

  it('without a company logo it says where to add one', async () => {
    setup()
    await expect.element(page.getByText('Add your company logo under Settings → Company')).toBeVisible()
    expect(document.querySelector('#material-logo')).toBeNull()
  })

  it('writes three variants in the brand voice; one is taken over into the fields, still editable', async () => {
    const { api } = setup()
    await page.getByLabelText('What is it about?').fill('Messe, Halle 3')
    await page.getByRole('button', { name: 'Write texts' }).click()
    expect(api.suggestTexts).toHaveBeenCalledWith({ formatId: 'flyer-a5', brief: 'Messe, Halle 3' })
    await expect.element(page.getByText('Kopf 2')).toBeVisible()
    await page.getByRole('button', { name: 'Use variant 2' }).click()
    await expect.element(page.getByLabelText('Headline')).toHaveValue('Kopf 2')
    await expect.element(page.getByLabelText('Text', { exact: true })).toHaveValue('Text 2')
    await expect.element(page.getByLabelText('Button')).toHaveValue('Los 2')
    await expect.element(page.getByTestId('flyer')).toHaveTextContent(/Kopf 2/)
    await page.getByLabelText('Headline').fill('Kopf 2, gekürzt')
    await expect.element(page.getByTestId('flyer')).toHaveTextContent(/Kopf 2, gekürzt/)
  })

  it('shows a failed export as the one error notice', async () => {
    const api = fakeApi({
      exportFile: vi.fn(async () => {
        throw new BrandRequestError({ error: 'Exporting brand material needs a browser on the server.', agent: null })
      }),
    })
    setup({ api })
    await page.getByRole('button', { name: 'Download PDF' }).click()
    await expect.element(page.getByText('Exporting brand material needs a browser on the server.')).toBeVisible()
  })
})
