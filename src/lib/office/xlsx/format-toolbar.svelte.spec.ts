import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import FormatToolbar from './format-toolbar.svelte'
import { readStyles, type CellStyle } from './styles'

const plain = readStyles(null, null).xf(0)

function setup(style: CellStyle = plain) {
  const onstyle = vi.fn()
  const onwidth = vi.fn()
  const onheight = vi.fn()
  render(FormatToolbar, {
    style,
    plainFont: 'Calibri',
    width: 8.43,
    height: 15,
    onstyle,
    onwidth,
    onheight,
  })
  return { onstyle, onwidth, onheight }
}

const pick = (testid: string, value: string) => {
  const el = page.getByTestId(testid).element() as HTMLInputElement | HTMLSelectElement
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('format toolbar', () => {
  it('is a labelled toolbar whose toggles say whether they are on', async () => {
    setup({ ...plain, font: { ...plain.font, bold: true }, horizontal: 'center', wrap: true })
    await expect.element(page.getByRole('toolbar', { name: 'Cell format' })).toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Bold' }))
      .toHaveAttribute('aria-pressed', 'true')
    await expect
      .element(page.getByRole('button', { name: 'Italic' }))
      .toHaveAttribute('aria-pressed', 'false')
    await expect
      .element(page.getByRole('button', { name: 'Center' }))
      .toHaveAttribute('aria-pressed', 'true')
    await expect
      .element(page.getByRole('button', { name: 'Wrap text' }))
      .toHaveAttribute('aria-pressed', 'true')
    await expect
      .element(page.getByRole('button', { name: 'Align bottom' }))
      .toHaveAttribute('aria-pressed', 'true')
    await expect
      .element(page.getByRole('button', { name: 'Bold' }))
      .toHaveAttribute('aria-keyshortcuts', 'Control+B Meta+B')
    await expect.element(page.getByLabelText('Font', { exact: true })).toHaveValue('Calibri')
    await expect.element(page.getByLabelText('Font size')).toHaveValue('11')
    await expect.element(page.getByLabelText('Column width')).toHaveValue(8.43)
    await expect.element(page.getByLabelText('Row height')).toHaveValue(15)
  })

  it('hands each change to the page: toggles flip, a pressed alignment goes back to general', async () => {
    const { onstyle } = setup({
      ...plain,
      font: { ...plain.font, bold: true },
      horizontal: 'right',
    })
    await userEvent.click(page.getByRole('button', { name: 'Bold' }))
    expect(onstyle).toHaveBeenLastCalledWith({ bold: false })
    await userEvent.click(page.getByRole('button', { name: 'Underline' }))
    expect(onstyle).toHaveBeenLastCalledWith({ underline: true })
    await userEvent.click(page.getByRole('button', { name: 'Strikethrough' }))
    expect(onstyle).toHaveBeenLastCalledWith({ strike: true })
    await userEvent.click(page.getByRole('button', { name: 'Align right' }))
    expect(onstyle).toHaveBeenLastCalledWith({ horizontal: 'general' })
    await userEvent.click(page.getByRole('button', { name: 'Align left' }))
    expect(onstyle).toHaveBeenLastCalledWith({ horizontal: 'left' })
    await userEvent.click(page.getByRole('button', { name: 'Align top' }))
    expect(onstyle).toHaveBeenLastCalledWith({ vertical: 'top' })
    await userEvent.selectOptions(page.getByLabelText('Font', { exact: true }), 'Arial')
    expect(onstyle).toHaveBeenLastCalledWith({ fontName: 'Arial' })
    await userEvent.selectOptions(page.getByLabelText('Font size'), '14')
    expect(onstyle).toHaveBeenLastCalledWith({ fontSize: 14 })
    pick('xlsx-text-color', '#1f4e79')
    expect(onstyle).toHaveBeenLastCalledWith({ fontColor: '#1F4E79' })
    pick('xlsx-fill', '#ddebf7')
    expect(onstyle).toHaveBeenLastCalledWith({ fill: '#DDEBF7' })
  })

  it('clears a fill, and only when there is one', async () => {
    const { onstyle } = setup({ ...plain, fill: '#FFFF00' })
    await userEvent.click(page.getByRole('button', { name: 'No fill' }))
    expect(onstyle).toHaveBeenLastCalledWith({ fill: null })
  })

  it('borders: a preset with the chosen line style and colour; none removes', async () => {
    const { onstyle } = setup()
    await expect.element(page.getByRole('button', { name: 'No fill' })).toBeDisabled()
    await userEvent.selectOptions(page.getByLabelText('Line style'), 'medium')
    pick('xlsx-border-color', '#c00000')
    await userEvent.selectOptions(page.getByLabelText('Borders'), 'outer')
    expect(onstyle).toHaveBeenLastCalledWith({
      border: { preset: 'outer', style: 'medium', color: '#C00000' },
    })
    // The preset menu is a command, not a state: it goes back to its label.
    await expect.element(page.getByLabelText('Borders')).toHaveValue('')
    await userEvent.selectOptions(page.getByLabelText('Borders'), 'none')
    expect(onstyle).toHaveBeenLastCalledWith({ border: { preset: 'none' } })
  })

  it('sizes: a width or height typed in, empty is back to the default, nonsense is refused', async () => {
    const { onwidth, onheight } = setup()
    await userEvent.fill(page.getByLabelText('Column width'), '20')
    await userEvent.keyboard('{Tab}')
    expect(onwidth).toHaveBeenLastCalledWith(20)
    await userEvent.fill(page.getByLabelText('Row height'), '30')
    await userEvent.keyboard('{Tab}')
    expect(onheight).toHaveBeenLastCalledWith(30)
    await userEvent.fill(page.getByLabelText('Row height'), '')
    await userEvent.keyboard('{Tab}')
    expect(onheight).toHaveBeenLastCalledWith(null)
    onwidth.mockClear()
    await userEvent.fill(page.getByLabelText('Column width'), '999')
    await userEvent.keyboard('{Tab}')
    expect(onwidth).not.toHaveBeenCalled()
    await expect.element(page.getByLabelText('Column width')).toHaveValue(8.43)
  })
})
