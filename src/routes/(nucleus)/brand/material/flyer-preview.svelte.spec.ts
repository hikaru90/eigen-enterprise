import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import FlyerPreview from './flyer-preview.svelte'

describe('brand material: digital flyer preview', () => {
  const mounted: Array<() => void> = []
  afterEach(() => {
    for (const unmount of mounted.reverse()) unmount()
    mounted.length = 0
  })

  it('renders the copy inside a scope driven by the active set’s tokens', () => {
    const { container, unmount } = render(FlyerPreview, {
      setName: 'Blueprint',
      cssVars: { '--primary': 'rgb(255, 0, 0)' },
      darkCssVars: null,
      mode: 'light',
      headline: 'Open house',
      body: 'Come by on Friday.',
      cta: 'Book a slot',
    })
    mounted.push(unmount)
    const flyer = container.querySelector('[data-testid="flyer"]') as HTMLElement
    expect(flyer.getAttribute('data-system-theme')).toBe('light')
    expect(flyer.textContent).toContain('Open house')
    expect(flyer.textContent).toContain('Come by on Friday.')
    expect(flyer.textContent).toContain('Book a slot')
    expect(flyer.textContent).toContain('Blueprint')
    expect(getComputedStyle(flyer).getPropertyValue('--primary').trim()).toBe('rgb(255, 0, 0)')
  })

  it('switches to the dark tokens in dark mode', () => {
    const { container, unmount } = render(FlyerPreview, {
      setName: 'Blueprint',
      cssVars: { '--primary': 'rgb(255, 0, 0)' },
      darkCssVars: { '--primary': 'rgb(0, 255, 0)' },
      mode: 'dark',
      headline: 'H',
      body: 'B',
      cta: 'C',
    })
    mounted.push(unmount)
    const flyer = container.querySelector('[data-testid="flyer"]') as HTMLElement
    expect(flyer.classList.contains('dark')).toBe(true)
    expect(getComputedStyle(flyer).getPropertyValue('--primary').trim()).toBe('rgb(0, 255, 0)')
  })
})
