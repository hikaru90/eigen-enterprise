<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- the card href arrives
     resolved from the caller (route pages call resolve()); domain links are
     absolute outbound URLs marked rel="external". */
  import AppStatusDot from '$lib/components/app-status-dot.svelte'
  import { Badge } from '$lib/components/ui/badge'

  /**
   * One card of the Apps overview grid (/m/website/apps): an app — or the
   * company site (kind 'site', synthesized from ee settings + page counts).
   * The whole card is a link (stretched-link pattern, so the domain links can
   * stay real anchors above it); outbound domain links open in a new tab.
   */

  type AppCardLastDeploy = {
    status: 'running' | 'live' | 'failed'
    stage: 'fetching' | 'building' | 'starting' | 'health' | 'live' | 'failed'
    startedAt: string
    endedAt: string | null
  }

  let {
    name,
    kind,
    state,
    domains,
    url,
    repo = null,
    branch = null,
    rev = null,
    lastDeploy = null,
    href,
    pages = null,
  }: {
    name: string
    kind: 'web' | 'backend' | 'site'
    /** The app's deploy state; the site has none (its domain is its state). */
    state?: 'healthy' | 'deploying' | 'failed'
    domains: string[]
    url: string | null
    repo?: string | null
    branch?: string | null
    /** The short rev shown after the branch (already shortened). */
    rev?: string | null
    lastDeploy?: AppCardLastDeploy | null
    href: string
    /** Site cards only: published/draft page counts. */
    pages?: { published: number; drafts: number } | null
  } = $props()

  const kindLabel = $derived(kind === 'web' ? 'Web app' : kind === 'backend' ? 'Service' : 'Site')

  const deployLine = $derived.by(() => {
    if (!lastDeploy) return null
    const stage =
      lastDeploy.stage === 'live' ? 'Live' : lastDeploy.stage === 'failed' ? 'Failed' : 'Deploying'
    return `${stage} · ${relative(lastDeploy.endedAt ?? lastDeploy.startedAt)}`
  })

  function relative(iso: string): string {
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
    const diffSec = Math.round((Date.parse(iso) - Date.now()) / 1000)
    const diffMin = Math.round(diffSec / 60)
    const diffHr = Math.round(diffMin / 60)
    const diffDay = Math.round(diffHr / 24)
    if (Math.abs(diffSec) < 60) return rtf.format(diffSec, 'second')
    if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute')
    if (Math.abs(diffHr) < 24) return rtf.format(diffHr, 'hour')
    return rtf.format(diffDay, 'day')
  }

  const domainHref = (domain: string, index: number) =>
    index === 0 && url ? url : `https://${domain}`
  const countLine = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
</script>

<div
  class="relative flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background p-4 transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_rgb(0_0_0/0.04)]"
  data-testid="app-card"
>
  <div class="flex min-w-0 items-center gap-2">
    <a
      {href}
      class="min-w-0 truncate rounded-sm text-sm font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      data-testid="app-card-link"
    >
      {name}
    </a>
    <Badge variant="outline">{kindLabel}</Badge>
    {#if state}
      <span class="ml-auto shrink-0"><AppStatusDot status={state} /></span>
    {/if}
  </div>

  {#if domains.length > 0}
    <div class="relative z-10 flex min-w-0 flex-col gap-0.5">
      {#each domains as domain, i (domain)}
        <a
          href={domainHref(domain, i)}
          target="_blank"
          rel="noopener noreferrer external"
          onclick={(e) => e.stopPropagation()}
          class="w-fit max-w-full truncate text-xs text-foreground/70 underline-offset-2 hover:underline"
          data-testid="app-card-domain"
        >
          {domain}
        </a>
      {/each}
    </div>
  {:else if kind === 'site'}
    <span class="text-xs text-foreground/55">No domain yet</span>
  {/if}

  {#if repo}
    <span class="truncate text-xs text-foreground/55">{repo} · {branch}{rev ? `@${rev}` : ''}</span>
  {/if}

  {#if pages}
    <span class="text-xs text-foreground/55">
      {countLine(pages.published, 'page', 'pages')} published ·
      {countLine(pages.drafts, 'draft', 'drafts')}
    </span>
  {/if}

  {#if deployLine}
    <span class="text-xs text-foreground/55">Last deploy: {deployLine}</span>
  {/if}
</div>
