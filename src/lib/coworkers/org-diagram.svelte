<script lang="ts">
  import type { OrgNode, OrgPerson } from './org-tree'
  import type { SubmitFunction } from '@sveltejs/kit'
  import List from '@lucide/svelte/icons/list'
  import Network from '@lucide/svelte/icons/network'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import ActionFeedback from './action-feedback.svelte'
  import { feedbackFor } from './action-result'
  import AiMark from './ai-mark.svelte'
  import { modelFamily } from './model-family'
  import OrgChartTree from './org-chart-tree.svelte'
  import { buildOrgTree, managerOptions } from './org-tree'

  export type DiagramPerson = OrgPerson & {
    image?: string | null
    reportsToUserIds?: string[]
  }

  /**
   * Top-down visual organization diagram with crisp horizontal and vertical
   * reporting connectors and a Diagram | List toggle (List delegates to
   * OrgChartTree). Defensively handles optional `image` and `reportsToUserIds`.
   */
  let {
    people,
    me,
    form = null,
  }: {
    people: DiagramPerson[]
    me: { id: string; canManage: boolean }
    /** The page's last action answer (setPosition), shown under its seat. */
    form?: unknown
  } = $props()

  let view = $state<'diagram' | 'list'>('diagram')
  let editing = $state<string | null>(null)

  function primaryManagerId(person: DiagramPerson): string | null {
    return person.reportsToUserId ?? person.reportsToUserIds?.[0] ?? null
  }

  const normalizedPeople = $derived(
    people.map((person) => ({
      ...person,
      reportsToUserId: primaryManagerId(person),
    })),
  )
  const byId = $derived(new Map(people.map((person) => [person.id, person])))
  const tree = $derived(buildOrgTree(normalizedPeople))

  const canEdit = (person: DiagramPerson) =>
    me.canManage || (person.kind === 'human' && person.id === me.id)

  function extraManagers(person: DiagramPerson): string[] {
    const primary = primaryManagerId(person)
    const ids = (person.reportsToUserIds ?? []).filter(
      (id, i, all) => id !== primary && id !== person.id && all.indexOf(id) === i,
    )
    const names: string[] = []
    for (const id of ids) {
      const name = byId.get(id)?.name
      if (name) names.push(name)
    }
    return names
  }

  function toggle(id: string) {
    editing = editing === id ? null : id
  }

  /** Close the form once the seat is saved (not when it waits or is refused). */
  const closeWhenSaved =
    (id: string): SubmitFunction =>
    () =>
    async ({ result, update }) => {
      await update({ reset: false })
      if (result.type === 'success' && result.data?.ok === true && editing === id) editing = null
    }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div
      class="inline-flex rounded-full bg-muted p-1"
      role="group"
      aria-label={m.org_view_toggle_label()}
      data-testid="org-view-toggle"
    >
      <button
        type="button"
        aria-pressed={view === 'diagram'}
        data-testid="org-view-diagram"
        onclick={() => (view = 'diagram')}
        class={[
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
          view === 'diagram'
            ? 'bg-card text-foreground shadow-xs'
            : 'text-muted-foreground hover:text-foreground',
        ]}
      >
        <Network class="size-3.5" aria-hidden="true" />
        {m.org_view_diagram()}
      </button>
      <button
        type="button"
        aria-pressed={view === 'list'}
        data-testid="org-view-list"
        onclick={() => (view = 'list')}
        class={[
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
          view === 'list'
            ? 'bg-card text-foreground shadow-xs'
            : 'text-muted-foreground hover:text-foreground',
        ]}
      >
        <List class="size-3.5" aria-hidden="true" />
        {m.org_view_list()}
      </button>
    </div>
  </div>

  {#if view === 'list'}
    <OrgChartTree people={normalizedPeople} {me} {form} />
  {:else if tree.length === 0}
    <p class="text-sm text-muted-foreground" data-testid="org-empty">{m.org_empty()}</p>
  {:else}
    {#snippet branch(node: OrgNode, depth: number, isRoot: boolean)}
      {@const p = node.person as DiagramPerson}
      {@const formId = `diagram-seat-form-${p.id}`}
      {@const feedback = feedbackFor(form, 'setPosition', p.id)}
      {@const extra = extraManagers(p)}
      <li
        class={['flex flex-col items-center', !isRoot && 'org-child']}
        data-testid="org-seat"
        data-id={p.id}
        data-kind={p.kind}
        data-depth={depth}
      >
        <article
          class={[
            'rounded-xl border bg-card p-3.5 text-left shadow-xs transition-shadow hover:shadow-sm',
            editing === p.id ? 'w-80 border-foreground/25 shadow-sm' : 'w-64 border-border',
            p.kind === 'coworker' && p.enabled === false && 'opacity-75',
          ]}
          aria-labelledby="diagram-seat-name-{p.id}"
        >
          <div class="flex items-start gap-2.5">
            <UserAvatar
              name={p.name}
              image={p.image ?? null}
              size="md"
              testid="org-seat-avatar"
            />
            <div class="min-w-0 flex-1">
              <h3
                id="diagram-seat-name-{p.id}"
                class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-semibold"
              >
                <a
                  href={resolve('/(nucleus)/settings/org/[id]', { id: p.id })}
                  class="truncate rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="org-seat-name">{p.name}</a
                >
                {#if p.kind === 'coworker'}
                  <AiMark family={p.modelId ? modelFamily(p.modelId) : null} />
                  {#if p.enabled === false}
                    <span
                      class="text-xs font-normal text-muted-foreground"
                      data-testid="org-seat-off">{m.coworkers_off()}</span
                    >
                  {/if}
                {/if}
                {#if p.id === me.id}
                  <span class="text-xs font-normal text-muted-foreground">{m.org_you()}</span>
                {/if}
              </h3>
              <p class="truncate text-xs text-muted-foreground" data-testid="org-seat-title">
                {p.title ?? m.org_no_title()}
              </p>
            </div>
          </div>

          {#if extra.length > 0}
            <p class="mt-2 text-xs text-muted-foreground" data-testid="org-seat-extra-managers">
              {m.org_also_reports_to({ names: extra.join(', ') })}
            </p>
          {/if}

          {#if p.accountabilities.length > 0}
            <ul
              class="mt-2.5 list-disc space-y-0.5 pl-4 text-xs text-foreground/85"
              aria-label={m.org_accountabilities_of({ name: p.name })}
              data-testid="org-seat-accountabilities"
            >
              {#each p.accountabilities.slice(0, 3) as a, i (i)}
                <li class="truncate">{a}</li>
              {/each}
            </ul>
            {#if p.accountabilities.length > 3}
              <p
                class="mt-1 pl-4 text-xs text-muted-foreground"
                data-testid="org-seat-accountabilities-more"
              >
                {m.org_accountabilities_more({ count: p.accountabilities.length - 3 })}
              </p>
            {/if}
          {/if}

          <div class="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-2.5">
            <Button
              href={resolve('/(nucleus)/settings/org/[id]', { id: p.id })}
              variant="outline"
              size="sm"
              data-testid="org-seat-profile"
              >{m.org_open_profile()}<span class="sr-only">: {p.name}</span></Button
            >
            {#if canEdit(p)}
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={editing === p.id}
                aria-controls={formId}
                data-testid="org-seat-edit"
                onclick={() => toggle(p.id)}
                >{m.org_edit_seat()}<span class="sr-only">: {p.name}</span></Button
              >
            {/if}
          </div>

          {#if editing === p.id}
            <form
              id={formId}
              method="post"
              action="?/setPosition"
              use:enhance={closeWhenSaved(p.id)}
              class="mt-3 space-y-3 border-t border-border pt-3"
              data-testid="org-seat-form"
            >
              <input type="hidden" name="user_id" value={p.id} />
              <div class="space-y-1">
                <label class="text-xs font-medium" for="diagram-seat-title-{p.id}"
                  >{m.org_field_title()}</label
                >
                <Input
                  id="diagram-seat-title-{p.id}"
                  name="title"
                  value={p.title ?? ''}
                  required={p.kind === 'coworker'}
                  maxlength={120}
                />
              </div>
              <div class="space-y-1">
                <label class="text-xs font-medium" for="diagram-seat-acc-{p.id}"
                  >{m.org_field_accountabilities()}</label
                >
                <Textarea
                  id="diagram-seat-acc-{p.id}"
                  name="accountabilities"
                  value={p.accountabilities.join('\n')}
                  rows={3}
                  aria-describedby="diagram-seat-acc-hint-{p.id}"
                />
                <p id="diagram-seat-acc-hint-{p.id}" class="text-xs text-muted-foreground">
                  {m.org_accountabilities_hint()}
                </p>
              </div>
              {#if me.canManage}
                <div class="space-y-1">
                  <label class="text-xs font-medium" for="diagram-seat-manager-{p.id}"
                    >{m.org_field_reports_to()}</label
                  >
                  <select
                    id="diagram-seat-manager-{p.id}"
                    name="reports_to_user_id"
                    class="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
                    value={primaryManagerId(p) ?? ''}
                    data-testid="org-seat-manager"
                  >
                    <option value="">{m.org_reports_to_nobody()}</option>
                    {#each managerOptions(normalizedPeople, p.id) as o (o.id)}
                      <option value={o.id}
                        >{o.kind === 'coworker'
                          ? m.org_option_coworker({ name: o.name })
                          : o.name}</option
                      >
                    {/each}
                  </select>
                </div>
              {/if}
              <div class="flex flex-wrap gap-2">
                <Button type="submit" size="sm" data-testid="org-seat-save"
                  >{m.org_save_seat()}</Button
                >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onclick={() => (editing = null)}>{m.coworkers_cancel()}</Button
                >
              </div>
            </form>
          {/if}
          {#if feedback}
            <div class="mt-2"><ActionFeedback {feedback} testid="org-seat-feedback" /></div>
          {/if}
        </article>

        {#if node.reports.length > 0}
          <div class="org-stem" aria-hidden="true" data-testid="org-connector-stem"></div>
          <ul class="flex items-start justify-center" aria-label={m.org_reports_of({ name: p.name })}>
            {#each node.reports as child (child.person.id)}
              {@render branch(child, depth + 1, false)}
            {/each}
          </ul>
        {/if}
      </li>
    {/snippet}

    <div class="org-diagram-canvas overflow-x-auto pb-4" data-testid="org-diagram">
      <div class="inline-flex min-w-full justify-center px-2 py-2">
        <ul class="flex items-start justify-center gap-8" aria-label={m.org_chart_label()}>
          {#each tree as root (root.person.id)}
            {@render branch(root, 0, true)}
          {/each}
        </ul>
      </div>
    </div>
  {/if}
</div>

<style>
  .org-diagram-canvas {
    --org-line: color-mix(in oklab, var(--foreground) 22%, transparent);
  }
  .org-stem {
    width: 1.5px;
    height: 1.25rem;
    background: var(--org-line);
    flex-shrink: 0;
  }
  .org-child {
    position: relative;
    padding: 1.25rem 0.625rem 0;
  }
  .org-child::before,
  .org-child::after {
    content: '';
    position: absolute;
    top: 0;
    right: 50%;
    width: 50%;
    height: 1.25rem;
    border-top: 1.5px solid var(--org-line);
  }
  .org-child::after {
    right: auto;
    left: 50%;
    border-left: 1.5px solid var(--org-line);
  }
  .org-child:first-child::before {
    border-top: 0;
  }
  .org-child:first-child::after {
    border-top-left-radius: 6px;
  }
  .org-child:last-child::after {
    display: none;
  }
  .org-child:last-child::before {
    border-right: 1.5px solid var(--org-line);
    border-top-right-radius: 6px;
  }
  .org-child:only-child {
    padding-top: 1.25rem;
  }
  .org-child:only-child::before {
    display: none;
  }
  .org-child:only-child::after {
    display: block;
    left: 50%;
    width: 0;
    border-top: 0;
    border-left: 1.5px solid var(--org-line);
  }
</style>
