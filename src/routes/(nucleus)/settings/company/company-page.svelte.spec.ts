import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import CompanyPage from './+page.svelte'

const props = (company: { name: string | null; logo: { url: string; mime: string } | null }, form: unknown = null) =>
  ({ data: { company }, form, params: {} }) as never

describe('Settings → Company page', () => {
  it('edits the current name and offers an upload while there is no logo', async () => {
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    await expect.element(page.getByTestId('company-name-input')).toHaveValue('Kindred')
    await expect.element(page.getByTestId('company-logo-initial')).toHaveTextContent('K')
    await expect.element(page.getByTestId('company-logo-upload')).toHaveTextContent('Upload logo')
    await expect.element(page.getByTestId('company-logo-remove')).not.toBeInTheDocument()
    await expect
      .element(page.getByTestId('company-logo-file'))
      .toHaveAttribute('accept', 'image/png,image/jpeg,image/svg+xml,image/webp')
  })

  it('shows the logo with Replace and Remove once there is one', async () => {
    render(CompanyPage, props({ name: 'Kindred', logo: { url: '/api/company/logo/abc', mime: 'image/png' } }))
    await expect.element(page.getByTestId('company-logo-preview')).toHaveAttribute('src', '/api/company/logo/abc')
    await expect.element(page.getByTestId('company-logo-upload')).toHaveTextContent('Replace logo')
    await expect.element(page.getByTestId('company-logo-remove')).toBeInTheDocument()
  })

  it('says why an upload was refused, next to the logo', async () => {
    render(
      CompanyPage,
      props({ name: 'Kindred', logo: null }, { action: 'uploadLogo', error: 'This SVG contains scripts.' }),
    )
    await expect.element(page.getByTestId('company-logo').getByRole('alert')).toHaveTextContent('This SVG contains scripts.')
  })
})
