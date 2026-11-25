<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit'
  import { enhance } from '$app/forms'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import type { ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'
  import { getLocale } from '$lib/paraglide/runtime'
  import type { HandoverEntryView, HandoverView } from '$lib/server/memory/handover/service'
  import type { HandoverStatus } from '$lib/server/memory/handover/store'

  /**
   * Memory › Handover (plan/handover.md): every handover in the company, each
   * with its entries newest first — the day, a status chip, the topic, one
   * sentence, the detail link and who it is assigned to. Everyone reads; the
   * owner (canEdit) adds, changes, assigns and removes entries. Every form
   * posts to this page's actions (the handover.* registry tools); `formError`
   * is the refusal for one form ('new', 'add-<handover>' or an entry id).
   */
  let {
    handovers,
    members,
    userId,
    formError = null,
  }: {
    handovers: HandoverView[]
    members: Array<{ id: string; name: string }>
    userId: string
    formError?: ({ formId: string } & ShownError) | null
  } = $props()

  const STATUSES: Array<{ id: HandoverStatus; label: () => string; dot: string }> = [
    { id: 'decision_needed', label: () => m.handover_status_decision_needed(), dot: 'var(--tone-coral)' },
    { id: 'in_progress', label: () => m.handover_status_in_progress(), dot: 'var(--tone-yellow)' },
    { id: 'for_info', label: () => m.handover_status_for_info(), dot: 'var(--muted-foreground)' },
  ]
  const statusOf = (id: HandoverStatus) => STATUSES.find((s) => s.id === id)!
  const others = $derived(members.filter((p) => p.id !== userId))

  const dayLabel = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(getLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

  const byline = (h: HandoverView) =>
    [m.handover_kept_by({ owner: h.owner.name }), ...(h.subject ? [m.handover_for({ subject: h.subject.name })] : [])].join(' · ')

  /** The entry whose edit form is open (view state only). */
  let editing = $state<string | null>(null)
  const closeOnSuccess: SubmitFunction =
    () =>
    async ({ result, update }) => {
      await update()
      if (result.type === 'success') editing = null
    }

  /** A new assignment waits until the earlier task is done. */
  const assignable = (e: HandoverEntryView) => !e.assignedTask || e.assignedTask.status === 'done'

  const pill =
    'inline-flex h-8 shrink-0 items-center rounded-full px-3.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
  const ink = `${pill} bg-primary text-primary-foreground hover:opacity-85`
  const soft = `${pill} bg-muted text-foreground hover:bg-muted/70`
  const quiet =
    'inline-flex h-7 items-center rounded-full px-2.5 text-xs text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
  const select =
    'h-8 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring'
</script>

{#snippet message(id: string)}
  {#if formError?.formId === id}
    <ErrorNotice error={formError.error} agent={formError.agent} attempted="Changing a handover on /m/memory/handover" />
  {/if}
{/snippet}

{#snippet statusSelect(value: HandoverStatus, id: string)}
  <label class="sr-only" for={id}>{m.handover_entry_status()}</label>
  <select {id} name="status" class={select} {value}>
    {#each STATUSES as s (s.id)}
      <option value={s.id}>{s.label()}</option>
    {/each}
  </select>
{/snippet}

{#snippet entryFields(e: HandoverEntryView | null, prefix: string)}
  <div class="flex min-w-0 flex-col gap-2 sm:flex-row">
    <label class="sr-only" for="{prefix}-topic">{m.handover_entry_topic()}</label>
    <Input
      id="{prefix}-topic"
      name="topic"
      required
      maxlength={120}
      value={e?.topic ?? ''}
      placeholder={m.handover_entry_topic()}
      containerClass="sm:w-56"
    />
    {@render statusSelect(e?.status ?? 'for_info', `${prefix}-status`)}
  </div>
  <label class="sr-only" for="{prefix}-sentence">{m.handover_entry_sentence()}</label>
  <Textarea
    id="{prefix}-sentence"
    name="sentence"
    required
    maxlength={400}
    rows={2}
    value={e?.sentence ?? ''}
    placeholder={m.handover_entry_sentence()}
  />
  <label class="sr-only" for="{prefix}-link">{m.handover_entry_link()}</label>
  <Input id="{prefix}-link" name="link" maxlength={2000} value={e?.link ?? ''} placeholder={m.handover_entry_link()} dictation={false} />
{/snippet}

<div class="flex min-w-0 flex-col gap-6" data-testid="handover">
  <form method="POST" action="?/create" use:enhance class="flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-4" data-testid="handover-new">
    <div class="flex min-w-0 flex-col gap-0.5">
      <h2 class="text-[15px] leading-snug font-medium">{m.handover_new_title()}</h2>
      <p class="text-sm text-muted-foreground">{m.handover_new_hint()}</p>
    </div>
    <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
      <label class="sr-only" for="handover-title">{m.handover_title_label()}</label>
      <Input id="handover-title" name="title" required maxlength={200} placeholder={m.handover_title_placeholder()} containerClass="sm:flex-1" />
      <label class="sr-only" for="handover-subject">{m.handover_subject_label()}</label>
      <select id="handover-subject" name="subject_id" class={select}>
        <option value="">{m.handover_subject_none()}</option>
        {#each others as p (p.id)}
          <option value={p.id}>{m.handover_for({ subject: p.name })}</option>
        {/each}
      </select>
      <button type="submit" class={ink} data-testid="handover-create">{m.handover_create()}</button>
    </div>
    {@render message('new')}
  </form>

  {#if handovers.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="handover-empty">{m.handover_empty()}</p>
  {/if}

  {#each handovers as h (h.id)}
    <section class="flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-4" id="handover-{h.id}" data-testid="handover-{h.id}">
      <header class="flex min-w-0 flex-col gap-0.5">
        <h2 class="text-[15px] leading-snug font-medium">{h.title}</h2>
        <p class="text-sm text-muted-foreground">
          {byline(h)}
        </p>
      </header>

      {#if h.entries.length === 0}
        <p class="text-sm text-muted-foreground">{m.handover_entries_empty()}</p>
      {:else}
        <ul class="flex min-w-0 flex-col divide-y divide-border/60">
          {#each h.entries as e (e.id)}
            {@const s = statusOf(e.status)}
            <li class="flex min-w-0 flex-col gap-1.5 py-3 first:pt-0 last:pb-0" id="entry-{e.id}" data-testid="handover-entry">
              {#if editing === e.id && h.canEdit}
                <form
                  method="POST"
                  action="?/update"
                  use:enhance={closeOnSuccess}
                  class="flex min-w-0 flex-col gap-2"
                  data-testid="handover-entry-form-{e.id}"
                >
                  <input type="hidden" name="entry_id" value={e.id} />
                  {@render entryFields(e, `edit-${e.id}`)}
                  <div class="flex flex-wrap gap-2">
                    <button type="submit" class={ink}>{m.handover_entry_save()}</button>
                    <button type="button" class={soft} onclick={() => (editing = null)}>{m.handover_entry_cancel()}</button>
                  </div>
                </form>
              {:else}
                <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                  <time class="text-xs text-muted-foreground tabular-nums" datetime={e.date}>{dayLabel(e.date)}</time>
                  <span class="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-medium" data-testid="handover-status-{e.id}">
                    <span class="size-1.5 rounded-full" style:background={s.dot} aria-hidden="true"></span>
                    {s.label()}
                  </span>
                  <h3 class="text-sm font-medium">{e.topic}</h3>
                </div>
                <p class="max-w-[70ch] text-sm">{e.sentence}</p>
                <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {#if e.link}
                    <!-- eslint-disable svelte/no-navigation-without-resolve -- a stored link: an app path or an external http(s) address, validated by the service -->
                    <a
                      href={e.link}
                      class="underline-offset-2 hover:text-foreground hover:underline"
                      rel={e.link.startsWith('/') ? undefined : 'noopener noreferrer'}
                      data-testid="handover-entry-link-{e.id}">{m.handover_entry_details()}</a
                    >
                    <!-- eslint-enable svelte/no-navigation-without-resolve -->
                  {/if}
                  {#if e.assignee}
                    <span>
                      {e.assignedTask?.status === 'done'
                        ? m.handover_entry_assigned_done({ name: e.assignee.name })
                        : m.handover_entry_assigned({ name: e.assignee.name })}
                    </span>
                  {/if}
                  {#if e.writtenVia === 'brain'}
                    <span>{m.handover_entry_by_brain()}</span>
                  {/if}
                </div>
                {#if h.canEdit}
                  <div class="flex min-w-0 flex-wrap items-center gap-1">
                    <button type="button" class={quiet} onclick={() => (editing = e.id)} data-testid="handover-entry-edit-{e.id}">
                      {m.handover_entry_edit()}
                    </button>
                    {#if assignable(e) && others.length > 0}
                      <form method="POST" action="?/assign" use:enhance class="flex items-center gap-1" data-testid="handover-entry-assign-{e.id}">
                        <input type="hidden" name="entry_id" value={e.id} />
                        <label class="sr-only" for="assign-{e.id}">{m.handover_entry_assign_to()}</label>
                        <select id="assign-{e.id}" name="assignee_id" class="{select} h-7 text-xs" required>
                          {#each others as p (p.id)}
                            <option value={p.id}>{p.name}</option>
                          {/each}
                        </select>
                        <button type="submit" class={quiet}>{m.handover_entry_assign()}</button>
                      </form>
                    {/if}
                    <form method="POST" action="?/remove" use:enhance>
                      <input type="hidden" name="entry_id" value={e.id} />
                      <button type="submit" class={quiet} data-testid="handover-entry-remove-{e.id}">{m.handover_entry_remove()}</button>
                    </form>
                  </div>
                {/if}
              {/if}
              {@render message(e.id)}
            </li>
          {/each}
        </ul>
      {/if}

      {#if h.canEdit}
        <form
          method="POST"
          action="?/add"
          use:enhance
          class="flex min-w-0 flex-col gap-2 border-t border-border/60 pt-3"
          data-testid="handover-add-{h.id}"
        >
          <input type="hidden" name="handover_id" value={h.id} />
          {@render entryFields(null, `add-${h.id}`)}
          <div>
            <button type="submit" class={soft}>{m.handover_entry_add()}</button>
          </div>
          {@render message(`add-${h.id}`)}
        </form>
      {:else}
        <p class="text-xs text-muted-foreground" data-testid="handover-read-only-{h.id}">{m.handover_read_only({ owner: h.owner.name })}</p>
      {/if}
    </section>
  {/each}
</div>
