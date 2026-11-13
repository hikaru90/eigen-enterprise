import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import BannerPreview from './banner-preview.svelte'
import { formatById } from './formats'

describe('brand material: banner preview', () => {
  const mounted: Array<() => void> = []
  afterEach(() => {
    for (const unmount of mounted.reverse()) unmount()
    mounted.length = 0
  })

  const copy = { headline: 'Meet us at booth 4', body: 'New tools for teams.', cta: 'Say hello' }

  it('a social header at 1500 × 500 with the copy, in the active set’s tokens', () => {
    const { container, unmount } = render(BannerPreview, {
      setName: 'Blueprint',
      cssVars: { '--primary': 'rgb(255, 0, 0)' },
      darkCssVars: null,
      mode: 'light',
      format: formatById('banner-social'),
      ...copy,
    })
    mounted.push(unmount)
    const banner = container.querySelector('[data-testid="banner"]') as HTMLElement
    expect(banner.getAttribute('data-format')).toBe('banner-social')
    expect(banner.getAttribute('data-system-theme')).toBe('light')
    expect(banner.style.aspectRatio).toBe('1500 / 500')
    for (const text of ['Blueprint', copy.headline, copy.body, copy.cta])
      expect(banner.textContent).toContain(text)
    expect(getComputedStyle(banner).getPropertyValue('--primary').trim()).toBe('rgb(255, 0, 0)')
  })

  it('a roll-up banner at 850 × 2000 in the dark tokens', () => {
    const { container, unmount } = render(BannerPreview, {
      setName: 'Blueprint',
      cssVars: { '--primary': 'rgb(255, 0, 0)' },
      darkCssVars: { '--primary': 'rgb(0, 255, 0)' },
      mode: 'dark',
      format: formatById('banner-rollup'),
      ...copy,
    })
    mounted.push(unmount)
    const banner = container.querySelector('[data-testid="banner"]') as HTMLElement
    expect(banner.getAttribute('data-format')).toBe('banner-rollup')
    expect(banner.style.aspectRatio).toBe('850 / 2000')
    expect(banner.classList.contains('dark')).toBe(true)
    expect(banner.textContent).toContain(copy.headline)
    expect(getComputedStyle(banner).getPropertyValue('--primary').trim()).toBe('rgb(0, 255, 0)')
  })
})
