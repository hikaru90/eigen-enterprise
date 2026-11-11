/**
 * Browser-mode stub for SvelteKit's `$app/state`: a reactive `page` whose `data` a test sets
 * (for example `page.data.shell`) before rendering. Only what components under test read.
 */
export const page = $state<{ data: Record<string, unknown> }>({ data: {} })
