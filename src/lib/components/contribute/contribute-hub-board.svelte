<script lang="ts">
  import type { HubProposalDto } from '../../../../modules/contribute/hub/types'
  import { AREA_LABEL, KIND_LABEL, STATUS_LABEL } from '$lib/contribute/labels'
  import { groupHubProposals } from '../../../../modules/contribute/hub/board'

  /**
   * "All installs" (the central board, plan/contribute-phone-home.md §3): what
   * every install shared, grouped by status, then kind and area, with how many
   * installs asked and their summed score. Read-only: no voting and no authors
   * — there are none; only a random install id stands behind each proposal.
   */
  type Props = { proposals: HubProposalDto[] }

  let { proposals }: Props = $props()

  const groups = $derived(groupHubProposals(proposals))
  const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  const day = (d: string) => dayFmt.format(new Date(`${d}T00:00:00Z`))
  const installsLabel = (n: number) => `${n} ${n === 1 ? 'install' : 'installs'}`
</script>

<div class="flex flex-col gap-6" data-testid="hub-board">
  <p class="text-xs text-foreground/60">
    Shared by every eigenEnterprise install, rewritten in English on that install without names. Votes and status come from each install's own board.
  </p>
  {#if groups.length === 0}
    <p class="py-10 text-center text-sm text-foreground/60">No install has shared a proposal yet.</p>
  {:else}
    {#each groups as g, i (g.key)}
      {#if i === 0 || groups[i - 1]!.status !== g.status}
        <h2 class="-mb-3 text-sm font-medium" data-testid="hub-status-{g.status}">{STATUS_LABEL[g.status]}</h2>
      {/if}
      <section class="rounded-md border border-border" data-testid="hub-group">
        <header class="flex items-baseline justify-between gap-3 border-b border-border px-3 py-2">
          <span class="text-sm font-medium">{KIND_LABEL[g.kind]} · {AREA_LABEL[g.area]}</span>
          <span class="text-xs text-foreground/60 tabular-nums">{installsLabel(g.installs)} · score {g.score}</span>
        </header>
        <ul class="divide-y divide-border">
          {#each g.proposals as p (`${p.installId}/${p.remoteId}`)}
            <li class="flex gap-3 px-3 py-2.5" data-testid="hub-row">
              <span class="w-8 shrink-0 text-right text-sm font-medium tabular-nums" aria-label="Score">{p.score}</span>
              <div class="min-w-0 flex-1">
                <p class="text-sm [overflow-wrap:anywhere]" lang="en">{p.summary}</p>
                <p class="mt-1 text-xs text-muted-foreground">
                  originally {p.language} · v{p.appVersion} · {day(p.createdDay)}
                  {#if p.shippedDay}· shipped {day(p.shippedDay)}{/if}
                  · install {p.installId.slice(0, 8)}
                </p>
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</div>
