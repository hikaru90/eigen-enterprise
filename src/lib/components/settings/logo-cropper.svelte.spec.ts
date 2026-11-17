import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { LogoCrop } from '$lib/company/logo-crop'
import LogoCropper from './logo-cropper.svelte'

/** A 400×200 image (the frame is 240 px: it fits at 0.6, 240×120, centred 60 px down). */
function wideImage(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 400
  canvas.height = 200
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#c00'
  ctx.fillRect(0, 0, 200, 200)
  ctx.fillStyle = '#00c'
  ctx.fillRect(200, 0, 200, 200)
  return canvas.toDataURL('image/png')
}

function setup(props: { crop?: LogoCrop } = {}) {
  const onsave = vi.fn()
  const oncancel = vi.fn()
  render(LogoCropper, { props: { src: wideImage(), onsave, oncancel, ...props } })
  return { onsave, oncancel }
}

const saved = (onsave: ReturnType<typeof vi.fn>): LogoCrop => {
  expect(onsave).toHaveBeenCalledTimes(1)
  return onsave.mock.calls[0]![0] as LogoCrop
}

async function ready() {
  await expect.element(page.getByTestId('logo-crop-save')).toBeEnabled()
}

function frameBox() {
  return page.getByTestId('logo-crop-frame').element().getBoundingClientRect()
}

function pointer(type: string, target: EventTarget, x: number, y: number, pointerId = 1) {
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId, bubbles: true, cancelable: true }))
}

describe('logo cropper', () => {
  it('starts with the whole image fitted in the frame, and saves that crop', async () => {
    const { onsave } = setup()
    await ready()
    await page.getByTestId('logo-crop-save').click()
    expect(saved(onsave)).toEqual({ left: 0, top: -100, size: 400 })
  })

  it('zooms with the slider around the centre of the frame', async () => {
    const { onsave } = setup()
    await ready()
    await page.getByTestId('logo-crop-zoom').fill('50')
    await page.getByTestId('logo-crop-save').click()
    const crop = saved(onsave)
    expect(crop.size).toBeLessThan(400)
    expect(crop.left + crop.size / 2).toBeCloseTo(200)
    expect(crop.top + crop.size / 2).toBeCloseTo(100)
  })

  it('dragging moves the image within the frame', async () => {
    const { onsave } = setup()
    await ready()
    const box = frameBox()
    const frame = page.getByTestId('logo-crop-frame').element()
    pointer('pointerdown', frame, box.left + 100, box.top + 100)
    pointer('pointermove', window, box.left + 100, box.top + 130)
    pointer('pointerup', window, box.left + 100, box.top + 130)
    await page.getByTestId('logo-crop-save').click()
    // 30 px further down at 0.6 is 50 image pixels.
    expect(saved(onsave)).toEqual({ left: 0, top: -150, size: 400 })
  })

  it('the wheel zooms in around the pointer, without scrolling the page', async () => {
    const { onsave } = setup()
    await ready()
    const box = frameBox()
    const wheel = new WheelEvent('wheel', { deltaY: -300, clientX: box.left + 120, clientY: box.top + 120, bubbles: true, cancelable: true })
    page.getByTestId('logo-crop-frame').element().dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    await page.getByTestId('logo-crop-save').click()
    const crop = saved(onsave)
    expect(crop.size).toBeCloseTo(400 / Math.E)
    expect(crop.left + crop.size / 2).toBeCloseTo(200)
  })

  it('a pinch zooms', async () => {
    const { onsave } = setup()
    await ready()
    const box = frameBox()
    const frame = page.getByTestId('logo-crop-frame').element()
    pointer('pointerdown', frame, box.left + 100, box.top + 120, 1)
    pointer('pointerdown', frame, box.left + 140, box.top + 120, 2)
    pointer('pointermove', window, box.left + 80, box.top + 120, 1)
    pointer('pointermove', window, box.left + 160, box.top + 120, 2)
    pointer('pointerup', window, box.left + 80, box.top + 120, 1)
    pointer('pointerup', window, box.left + 160, box.top + 120, 2)
    await page.getByTestId('logo-crop-save').click()
    // The fingers moved from 40 to 80 px apart: twice the zoom.
    expect(saved(onsave).size).toBeCloseTo(200)
  })

  it('arrow keys move it and + zooms in; "Show it whole" goes back to the start', async () => {
    const { onsave } = setup()
    await ready()
    await page.getByTestId('logo-crop-frame').click()
    await userEvent.keyboard('{ArrowDown}')
    await userEvent.keyboard('+')
    await page.getByTestId('logo-crop-fit').click()
    await page.getByTestId('logo-crop-save').click()
    expect(saved(onsave)).toEqual({ left: 0, top: -100, size: 400 })
  })

  it('a re-crop starts where the stored crop left it', async () => {
    const { onsave } = setup({ crop: { left: 150, top: 50, size: 100 } })
    await ready()
    await page.getByTestId('logo-crop-save').click()
    const crop = saved(onsave)
    expect(crop.left).toBeCloseTo(150)
    expect(crop.top).toBeCloseTo(50)
    expect(crop.size).toBeCloseTo(100)
  })

  it('shows the result at the sizes the app uses, and Cancel hands back nothing', async () => {
    const { onsave, oncancel } = setup()
    await ready()
    expect(page.getByTestId('logo-crop-preview').elements()).toHaveLength(2)
    await page.getByTestId('logo-crop-cancel').click()
    expect(oncancel).toHaveBeenCalledTimes(1)
    expect(onsave).not.toHaveBeenCalled()
  })
})
