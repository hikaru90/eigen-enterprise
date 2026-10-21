import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import WebsiteActivityPanel from './website-activity-panel.svelte'

/** W5: the Website module page's recent activity list (plain sentences, kinds, links). */

const fiveMinutesAgo = () => new Date(Date.now() - 5 * 60_000).toISOString()

describe('website-activity-panel: the list', () => {
  it('shows each item: time ago, kind badge, and the sentence (linked when it has an href)', async () => {
    render(WebsiteActivityPanel, {
      props: {
        activity: {
          managed: true,
          items: [
            {
              at: fiveMinutesAgo(),
              source: 'server',
              kind: 'deploy',
              text: 'Deployed shop',
              workload: 'shop',
              href: '/m/website/apps/shop',
            },
            {
              at: fiveMinutesAgo(),
              source: 'tool',
              kind: 'domain',
              text: 'Pointed shop.kindred.dev at shop',
              workload: null,
              href: null,
            },
          ],
        },
      },
    })
    await expect.element(page.getByText('Deployed shop')).toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: 'Deployed shop' }))
      .toHaveAttribute('href', '/m/website/apps/shop')
    await expect.element(page.getByText('Pointed shop.kindred.dev at shop')).toBeInTheDocument()
    expect((await page.getByRole('link', { name: /Pointed/ }).elements()).length).toBe(0)
    await expect.element(page.getByText('Deploy', { exact: true })).toBeInTheDocument()
    await expect.element(page.getByText('Domain', { exact: true })).toBeInTheDocument()
    expect((await page.getByText('5 minutes ago').elements()).length).toBe(2)
  })

  it('the kind badge labels every kind in plain words', async () => {
    render(WebsiteActivityPanel, {
      props: {
        activity: {
          managed: true,
          items: [
            {
              at: fiveMinutesAgo(),
              source: 'server',
              kind: 'secret',
              text: 'Set a secret for shop',
              workload: null,
              href: null,
            },
            {
              at: fiveMinutesAgo(),
              source: 'server',
              kind: 'key',
              text: 'Added a deploy key',
              workload: null,
              href: null,
            },
            {
              at: fiveMinutesAgo(),
              source: 'server',
              kind: 'app',
              text: 'Removed the app “old”',
              workload: null,
              href: null,
            },
            {
              at: fiveMinutesAgo(),
              source: 'tool',
              kind: 'page',
              text: 'Published the About page',
              workload: null,
              href: null,
            },
            {
              at: fiveMinutesAgo(),
              source: 'server',
              kind: 'server',
              text: 'Updated the server’s edge routing',
              workload: null,
              href: null,
            },
          ],
        },
      },
    })
    for (const label of ['Secret', 'Key', 'App', 'Page', 'Server']) {
      await expect.element(page.getByText(label, { exact: true })).toBeInTheDocument()
    }
  })
})

describe('website-activity-panel: the quiet states', () => {
  it('no items yet says so plainly', async () => {
    render(WebsiteActivityPanel, { props: { activity: { managed: true, items: [] } } })
    await expect.element(page.getByTestId('activity-empty')).toHaveTextContent('Nothing yet.')
  })

  it('not managed by ee: the list stays (kernel events) with the one-line note', async () => {
    render(WebsiteActivityPanel, {
      props: {
        activity: {
          managed: false,
          items: [
            {
              at: fiveMinutesAgo(),
              source: 'tool',
              kind: 'page',
              text: 'Published the About page',
              workload: null,
              href: null,
            },
          ],
        },
      },
    })
    await expect.element(page.getByText('Published the About page')).toBeInTheDocument()
    await expect
      .element(page.getByTestId('activity-unmanaged'))
      .toHaveTextContent('Server events appear once this server is managed by ee.')
  })

  it('a load failure shows the plain sentence instead of a list', async () => {
    render(WebsiteActivityPanel, {
      props: {
        activity: null,
        error: "The server's deploy agent could not read the server status.",
      },
    })
    await expect
      .element(page.getByTestId('activity-error'))
      .toHaveTextContent("The server's deploy agent could not read the server status.")
    expect((await page.getByTestId('activity-item').elements()).length).toBe(0)
    expect((await page.getByTestId('activity-unmanaged').elements()).length).toBe(0)
  })
})
