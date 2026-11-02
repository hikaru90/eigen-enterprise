import type { PickerCard } from './types'
import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import PickerBreadcrumb from './picker-breadcrumb.svelte'
import PickerGrid from './picker-grid.svelte'

const card = (id: string, level: PickerCard['level'], parentId: string | null): PickerCard => ({
  id,
  level,
  parentId,
  name: `Name ${id}`,
  description: `About ${id}`,
  preview: { light: `/p/${id}-light.svg`, dark: `/p/${id}-dark.svg` },
})

describe('brand picker components', () => {
  const mounted: Array<() => void> = []
  afterEach(() => {
    for (const unmount of mounted.reverse()) unmount()
    mounted.length = 0
  })

  it('the grid renders one linked preview card per node, image per preview mode', () => {
    const cards = [card('a', 'genre', null), card('b', 'genre', null)]
    const light = render(PickerGrid, { cards, mode: 'light' })
    mounted.push(light.unmount)
    const links = [...light.container.querySelectorAll('a[data-picker-card]')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/brand?style=a', '/brand?style=b'])
    expect(light.container.querySelector('img')?.getAttribute('src')).toBe('/p/a-light.svg')
    expect(light.container.textContent).toContain('Name a')
    expect(light.container.textContent).toContain('About b')

    const dark = render(PickerGrid, { cards, mode: 'dark' })
    mounted.push(dark.unmount)
    expect(dark.container.querySelector('img')?.getAttribute('src')).toBe('/p/a-dark.svg')
  })

  it('the breadcrumb links every ancestor and marks the current node', () => {
    const trail = [card('g', 'genre', null), card('s', 'style', 'g'), card('v', 'variant', 's')]
    const { container, unmount } = render(PickerBreadcrumb, { trail })
    mounted.push(unmount)
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['/brand', '/brand?style=g', '/brand?style=s'])
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain('Name v')
  })

  it('at the top level the breadcrumb is just the current root crumb', () => {
    const { container, unmount } = render(PickerBreadcrumb, { trail: [] })
    mounted.push(unmount)
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain('All styles')
  })
})
