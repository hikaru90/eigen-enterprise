<script lang="ts">
  import type { Pipeline, PipelineItem, PipelineStage } from '../types'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import type { AgentReport } from '$lib/errors/agent-report'
  import {
    CONTACT_LIMITS,
    PIPELINE_STAGES,
    STAGE_INFO,
    VIA_LABELS,
    VIA_TYPES,
    relativeDays,
  } from '../types'
  import LogContactForm from './log-contact-form.svelte'

  /**
   * The contact pipeline (Contribute 8c6a0cb7), worked the Getting Things Done
   * way: Ony's four groups as GTD lists — our move (next actions), waiting for
   * a reply, keep in the loop (tickler), not contacted yet (inbox) — with her
   * columns: who, last contacted, who holds it on our side, how we are in
   * touch, latest status, next step, and the list's day. Who holds it, how,
   * the status, the next step and the day are edited in place; a contact moves
   * by its list menu or by dragging its row onto another list. The weekly
   * review counts what needs a look and can narrow the lists to just that.
   * Every change goes through `onsave` (the page posts it); nothing is
   * inferred — the list is what a person picks.
   */
  let {
    pipeline,
    onsave,
    logError = null,
  }: {
    pipeline: Pipeline
    /** Save one change; resolves to the error to show on that row, or null. */
    onsave: (id: string, patch: Record<string, string>) => Promise<string | null>
    /** A "Log contact" that failed, for the row it came from. */
    logError?: { id: string; message: string; agent?: AgentReport | null } | null
  } = $props()

  let reviewOnly = $state(false)
  let errors = $state<Record<string, string>>({})
  let saving = $state<string | null>(null)
  let dragOver = $state<PipelineStage | null>(null)
  /** undefined = untouched (a failed log reopens its row); null = all closed. */
  let logOpenId = $state<string | null | undefined>(undefined)
  const logOpen = $derived(logOpenId === undefined ? (logError?.id ?? null) : logOpenId)

  const total = $derived(pipeline.groups.reduce((n, g) => n + g.items.length, 0))
  const shown = (items: readonly PipelineItem[]) =>
    reviewOnly ? items.filter((i) => i.review.needsReview) : items

  async function save(id: string, patch: Record<string, string>): Promise<void> {
    saving = id
    try {
      const err = await onsave(id, patch)
      if (err) errors[id] = err
      else delete errors[id]
    } finally {
      saving = null
    }
  }

  function onfield(id: string, key: string) {
    return (e: Event) =>
      save(id, { [key]: (e.currentTarget as HTMLInputElement | HTMLSelectElement).value })
  }

  function ondragstart(e: DragEvent, id: string): void {
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  function ondrop(e: DragEvent, stage: PipelineStage): void {
    e.preventDefault()
    dragOver = null
    const id = e.dataTransfer?.getData('text/plain')
    const item = pipeline.groups.flatMap((g) => g.items).find((i) => i.id === id)
    if (item && item.stage !== stage) void save(item.id, { stage })
  }

  const daysSince = (day: string) =>
    Math.round(
      (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${pipeline.today}T00:00:00Z`)) / 86_400_000,
    )

  /** What the weekly review notices on this row, in words. */
  function flags(i: PipelineItem): string[] {
    const out: string[] = []
    if (i.review.staleWaiting && i.review.daysWaiting !== null)
      out.push(`Waiting ${i.review.daysWaiting} days`)
    if (i.review.overdue && i.review.daysFromToday !== null)
      out.push(`${STAGE_INFO[i.stage].dateLabel} ${relativeDays(i.review.daysFromToday)}`)
    if (i.review.missingNextStep) out.push('No next step')
    return out
  }

  const cell = 'px-2 py-2 align-top'
  const control = 'border-input bg-card h-8 w-full min-w-28 rounded-md border px-2 text-sm'
</script>

<section
  class="grid gap-2 rounded-lg border border-border p-4"
  aria-labelledby="pipeline-review-title"
  data-testid="pipeline-review"
>
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h3 id="pipeline-review-title" class="text-sm font-medium">Weekly review</h3>
    <Button
      type="button"
      size="sm"
      variant={reviewOnly ? 'default' : 'outline'}
      aria-pressed={reviewOnly}
      onclick={() => (reviewOnly = !reviewOnly)}
      data-testid="pipeline-review-toggle"
      >{reviewOnly ? 'Show everyone' : 'Show only what needs a look'}</Button
    >
  </div>
  <ul class="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="pipeline-review-counts">
    <li class={pipeline.review.waitingTooLong > 0 ? 'text-destructive' : 'text-muted-foreground'}>
      {pipeline.review.waitingTooLong} waiting longer than {pipeline.review.waitingDays} days
    </li>
    <li class={pipeline.review.overdue > 0 ? 'text-destructive' : 'text-muted-foreground'}>
      {pipeline.review.overdue} past their day
    </li>
    <li class={pipeline.review.nextWithoutStep > 0 ? 'text-foreground' : 'text-muted-foreground'}>
      {pipeline.review.nextWithoutStep} of our moves without a next step
    </li>
    <li class={pipeline.review.inbox > 0 ? 'text-foreground' : 'text-muted-foreground'}>
      {pipeline.review.inbox} in the inbox to process
    </li>
  </ul>
</section>

{#if total === 0}
  <p class="mt-4 text-sm text-muted-foreground" data-testid="pipeline-empty">
    No contacts yet. Add the people you know and they start in the inbox.
  </p>
{/if}

{#each pipeline.groups as group, n (group.stage)}
  {@const info = STAGE_INFO[group.stage]}
  {@const items = shown(group.items)}
  <section
    class="mt-6 rounded-lg border {dragOver === group.stage
      ? 'border-foreground bg-muted/40'
      : 'border-border'}"
    aria-labelledby={`pipeline-${group.stage}-title`}
    data-testid={`pipeline-group-${group.stage}`}
    ondragover={(e) => {
      e.preventDefault()
      dragOver = group.stage
    }}
    ondragleave={() => (dragOver = null)}
    ondrop={(e) => ondrop(e, group.stage)}
  >
    <header
      class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3"
    >
      <div class="min-w-0">
        <h3 id={`pipeline-${group.stage}-title`} class="text-sm font-medium">
          {n + 1} · {info.label} <span class="font-normal text-muted-foreground">— {info.gtd}</span>
        </h3>
        <p class="text-xs text-muted-foreground">{info.hint}</p>
      </div>
      <span class="text-xs text-muted-foreground" data-testid="pipeline-group-count"
        >{group.items.length}</span
      >
    </header>
    {#if items.length === 0}
      <p class="px-4 py-3 text-xs text-muted-foreground">
        {reviewOnly && group.items.length > 0 ? 'Nothing here needs a look.' : 'Nobody here.'}
      </p>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full min-w-[960px] text-sm">
          <thead class="text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" class="px-2 py-2 pl-4 font-medium">Who</th>
              <th scope="col" class="px-2 py-2 font-medium">Last contacted</th>
              <th scope="col" class="px-2 py-2 font-medium">Held by</th>
              <th scope="col" class="px-2 py-2 font-medium">Via</th>
              <th scope="col" class="px-2 py-2 font-medium">Latest status</th>
              <th scope="col" class="px-2 py-2 font-medium">Next step</th>
              <th scope="col" class="px-2 py-2 font-medium">{info.dateLabel}</th>
              <th scope="col" class="px-2 py-2 pr-4 font-medium">List</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            {#each items as i (i.id)}
              {@const rowFlags = flags(i)}
              <tr
                draggable="true"
                ondragstart={(e) => ondragstart(e, i.id)}
                class={i.review.needsReview ? 'bg-muted/30' : ''}
                aria-busy={saving === i.id}
                data-testid="pipeline-row"
                data-id={i.id}
                data-review={i.review.needsReview ? 'true' : 'false'}
              >
                <td class="{cell} pl-4">
                  <a class="font-medium hover:underline" href={resolve(`/m/email/people/${i.id}`)}
                    >{i.name}</a
                  >
                  {#if i.organisation}<div class="text-xs text-muted-foreground">
                      {i.organisation}
                    </div>{/if}
                  {#if i.stage === 'waiting' && i.review.daysWaiting !== null && !i.review.staleWaiting}
                    <div class="text-xs text-muted-foreground">
                      Waiting {i.review.daysWaiting} days
                    </div>
                  {/if}
                  {#if rowFlags.length > 0}
                    <div class="text-xs font-medium text-destructive" data-testid="pipeline-flags">
                      {rowFlags.join(' · ')}
                    </div>
                  {/if}
                  {#if errors[i.id]}<ErrorNotice
                      error={errors[i.id]!}
                      attempted={`Saving a change to ${i.name} on the pipeline`}
                      class="text-xs"
                    />{/if}
                </td>
                <td class="{cell} whitespace-nowrap text-xs text-muted-foreground">
                  {i.lastContactedOn ? relativeDays(daysSince(i.lastContactedOn)) : 'Not yet'}
                  {#if logOpen !== i.id}
                    <div>
                      <button
                        type="button"
                        class="underline underline-offset-2 hover:text-foreground"
                        onclick={() => (logOpenId = i.id)}>Log contact</button
                      >
                    </div>
                  {/if}
                </td>
                <td class={cell}>
                  <select
                    class={control}
                    aria-label={`Who holds ${i.name}`}
                    value={i.ownerId ?? ''}
                    onchange={onfield(i.id, 'ownerId')}
                  >
                    <option value="">Nobody yet</option>
                    {#each pipeline.people as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
                    {#if i.ownerId && !pipeline.people.some((p) => p.id === i.ownerId)}<option
                        value={i.ownerId}>{i.ownerName}</option
                      >{/if}
                  </select>
                </td>
                <td class={cell}>
                  <select
                    class={control}
                    aria-label={`How we are in touch with ${i.name}`}
                    value={i.via ?? ''}
                    onchange={onfield(i.id, 'via')}
                  >
                    <option value="">—</option>
                    {#each VIA_TYPES as v (v)}<option value={v}>{VIA_LABELS[v]}</option>{/each}
                  </select>
                </td>
                <td class={cell}>
                  <input
                    class={control}
                    aria-label={`Latest status with ${i.name}`}
                    maxlength={CONTACT_LIMITS.latestStatus}
                    placeholder="Where things stand"
                    value={i.latestStatus ?? ''}
                    onchange={onfield(i.id, 'latestStatus')}
                  />
                </td>
                <td class={cell}>
                  <input
                    class={control}
                    aria-label={`Next step with ${i.name}`}
                    maxlength={CONTACT_LIMITS.nextStep}
                    placeholder={i.stage === 'next' ? 'The concrete next step' : 'Optional'}
                    value={i.nextStep ?? ''}
                    onchange={onfield(i.id, 'nextStep')}
                  />
                </td>
                <td class={cell}>
                  <input
                    class={control}
                    type="date"
                    aria-label={`${info.dateLabel} (${i.name})`}
                    value={i.nextFollowUpOn ?? ''}
                    onchange={onfield(i.id, 'nextFollowUpOn')}
                  />
                </td>
                <td class="{cell} pr-4">
                  <select
                    class={control}
                    aria-label={`List for ${i.name}`}
                    value={i.stage}
                    onchange={onfield(i.id, 'stage')}
                  >
                    {#each PIPELINE_STAGES as s (s)}<option value={s}>{STAGE_INFO[s].label}</option
                      >{/each}
                  </select>
                </td>
              </tr>
              {#if logOpen === i.id}
                <tr>
                  <td colspan="8" class="px-4 py-3">
                    <LogContactForm
                      contactId={i.id}
                      name={i.name}
                      today={pipeline.today}
                      askStage
                      error={logError && logError.id === i.id ? logError.message : null}
                      agent={logError && logError.id === i.id ? (logError.agent ?? null) : null}
                      oncancel={() => (logOpenId = null)}
                      ondone={() => (logOpenId = null)}
                    />
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/each}
