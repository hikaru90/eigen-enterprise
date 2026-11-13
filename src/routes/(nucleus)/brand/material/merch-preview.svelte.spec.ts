import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { formatById } from './formats'
import MerchPreview from './merch-preview.svelte'

describe('brand material: merch preview', () => {
  const mounted: Array<() => void> = []
  afterEach(() => {
    for (const unmount of mounted.reverse()) unmount()
    mounted.length = 0
  })

  it('a T-shirt print carries the slogan and the brand mark, in the active set’s tokens', () => {
    const { container, unmount } = render(MerchPreview, {
      setName: 'Blueprint',
      cssVars: { '--primary': 'rgb(255, 0, 0)' },
      darkCssVars: null,
      mode: 'light',
      format: formatById('merch-shirt'),
      headline: 'Built with care',
    })
    mounted.push(unmount)
    const merch = container.querySelector('[data-testid="merch"]') as HTMLElement
    expect(merch.getAttribute('data-format')).toBe('merch-shirt')
    expect(merch.style.aspectRatio).toBe('300 / 400')
    expect(merch.textContent).toContain('Built with care')
    expect(merch.textContent).toContain('Blueprint')
    expect(getComputedStyle(merch).getPropertyValue('--primary').trim()).toBe('rgb(255, 0, 0)')
  })

  it('a mug wrap (200 × 90) and a tote (300 × 300) in the dark tokens', () => {
    for (const id of ['merch-mug', 'merch-tote']) {
      const format = formatById(id)
      const { container, unmount } = render(MerchPreview, {
        setName: 'Blueprint',
        cssVars: { '--primary': 'rgb(255, 0, 0)' },
        darkCssVars: { '--primary': 'rgb(0, 255, 0)' },
        mode: 'dark',
        format,
        headline: 'Slogan',
      })
      mounted.push(unmount)
      const merch = container.querySelector('[data-testid="merch"]') as HTMLElement
      expect(merch.getAttribute('data-format')).toBe(id)
      expect(merch.style.aspectRatio).toBe(`${format.width} / ${format.height}`)
      expect(merch.classList.contains('dark')).toBe(true)
      expect(getComputedStyle(merch).getPropertyValue('--primary').trim()).toBe('rgb(0, 255, 0)')
    }
  })
})
