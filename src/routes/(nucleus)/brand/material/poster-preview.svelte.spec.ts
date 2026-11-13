import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { formatById } from './formats'
import PosterPreview from './poster-preview.svelte'

describe('brand material: trade-show poster preview', () => {
  const mounted: Array<() => void> = []
  afterEach(() => {
    for (const unmount of mounted.reverse()) unmount()
    mounted.length = 0
  })

  it('an A1 poster with the copy, in the active set’s tokens', () => {
    const { container, unmount } = render(PosterPreview, {
      setName: 'Blueprint',
      cssVars: { '--primary': 'rgb(255, 0, 0)' },
      darkCssVars: null,
      mode: 'light',
      format: formatById('poster-a1'),
      headline: 'Hall 3, booth 12',
      body: 'Live demos all day.',
      cta: 'Scan to book',
    })
    mounted.push(unmount)
    const poster = container.querySelector('[data-testid="poster"]') as HTMLElement
    expect(poster.getAttribute('data-format')).toBe('poster-a1')
    expect(poster.style.aspectRatio).toBe('594 / 841')
    for (const text of ['Blueprint', 'Hall 3, booth 12', 'Live demos all day.', 'Scan to book'])
      expect(poster.textContent).toContain(text)
    expect(getComputedStyle(poster).getPropertyValue('--primary').trim()).toBe('rgb(255, 0, 0)')
  })

  it('an A2 poster in the dark tokens', () => {
    const { container, unmount } = render(PosterPreview, {
      setName: 'Blueprint',
      cssVars: { '--primary': 'rgb(255, 0, 0)' },
      darkCssVars: { '--primary': 'rgb(0, 255, 0)' },
      mode: 'dark',
      format: formatById('poster-a2'),
      headline: 'H',
      body: 'B',
      cta: 'C',
    })
    mounted.push(unmount)
    const poster = container.querySelector('[data-testid="poster"]') as HTMLElement
    expect(poster.getAttribute('data-format')).toBe('poster-a2')
    expect(poster.style.aspectRatio).toBe('420 / 594')
    expect(poster.classList.contains('dark')).toBe(true)
    expect(getComputedStyle(poster).getPropertyValue('--primary').trim()).toBe('rgb(0, 255, 0)')
  })
})
