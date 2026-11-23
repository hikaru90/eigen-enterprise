import { SvelteURL } from 'svelte/reactivity'

/**
 * Browser-mode stub for SvelteKit's `$app/state`: a reactive `page` whose `data` a test sets
 * (for example `page.data.shell`) before rendering, and the test page's own `url`. Only what
 * components under test read.
 */
export const page = $state<{ data: Record<string, unknown>; url: URL }>({
  data: {},
  url: new SvelteURL(window.location.href),
})

/** SvelteKit's `updated`: no new build in component specs (specs pass their own `check`). */
export const updated = { current: false, check: async (): Promise<boolean> => false }
