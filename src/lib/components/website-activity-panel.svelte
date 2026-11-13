<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- the hrefs arrive
     from the website.activity tool (/m/website/apps/<workload>); the panel is
     a dumb view and never builds routes itself. */
  import type { ActivityKind, ActivityResult } from '../../../modules/website/activity-tools'
  import { Badge } from '$lib/components/ui/badge'
  import * as Card from '$lib/components/ui/card'

  /**
   * Recent activity on the Website module page (plan/phase-website-apps-ux.md
   * W5): a compact list of what happened — deploys, domains, secrets, keys,
   * apps, pages — as plain sentences from the website.activity read tool.
   */

  let {
    activity,
    error = null,
  }: {
    activity: ActivityResult | null
    /** A plain sentence when the activity could not be loaded at all. */
    error?: string | null
  } = $props()

  const kindLabel: Record<ActivityKind, string> = {
    deploy: 'Deploy',
    domain: 'Domain',
    secret: 'Secret',
    key: 'Key',
    app: 'App',
    page: 'Page',
    server: 'Server',
  }

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
</script>

<Card.Root data-testid="website-activity-panel">
  <Card.Header>
    <Card.Title>Recent activity</Card.Title>
    <Card.Description>Deploys, domains, secrets and pages, newest first.</Card.Description>
  </Card.Header>
  <Card.Content>
    {#if error}
      <p class="text-sm text-destructive" data-testid="activity-error">{error}</p>
    {:else if !activity || activity.items.length === 0}
      <p class="text-sm text-muted-foreground" data-testid="activity-empty">Nothing yet.</p>
    {:else}
      <ul class="divide-y divide-border">
        {#each activity.items as item, i (i)}
          <li
            class="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0"
            data-testid="activity-item"
          >
            <span
              class="w-20 shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted-foreground"
              title={item.at}
            >
              {relative(item.at)}
            </span>
            <Badge variant="outline" class="shrink-0">{kindLabel[item.kind]}</Badge>
            {#if item.href}
              <a href={item.href} class="min-w-0 text-sm underline-offset-2 hover:underline">
                {item.text}
              </a>
            {:else}
              <span class="min-w-0 text-sm">{item.text}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </Card.Content>
  {#if activity && !activity.managed}
    <Card.Footer>
      <p class="text-xs text-muted-foreground" data-testid="activity-unmanaged">
        Server events appear once this server is managed by ee.
      </p>
    </Card.Footer>
  {/if}
</Card.Root>
