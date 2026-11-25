<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit'
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
  import { buildOrgTree, managerIdsOf, managerNames, managerOptions, type OrgNode, type OrgPerson } from './org-tree'

  /**
   * The org chart as nested lists (plan/phase-ai-coworkers.md C5): each seat a
   * card — picture, name (to the profile), the AI mark and model family for a
   * co-worker, title, accountabilities — with the people who report to it
   * below, indented. Nested lists keep it readable by screen readers (each
   * level is announced) and on a phone (a thin indent per level).
   *
   * "Edit seat" opens the seat's form in place (org.set_position): the owner
   * and admins edit anyone's title, accountabilities and reports-to; a member
   * edits only their own title and accountabilities.
   */
  let {
    people,
    me,
    form = null,
  }: {
    people: OrgPerson[]
    me: { id: string; canManage: boolean }
    /** The page's last action answer (setPosition), shown under its seat. */
    form?: unknown
  } = $props()

  const tree = $derived(buildOrgTree(people))
  let editing = $state<string | null>(null)
  let draftManagers = $state<string[]>([])

  const canEdit = (p: OrgPerson) => me.canManage || (p.kind === 'human' && p.id === me.id)

  function toggle(id: string) {
    if (editing === id) {
      editing = null
      draftManagers = []
    } else {
      const target = people.find((x) => x.id === id)
      editing = id
      draftManagers = target ? [...managerIdsOf(target)] : []
    }
  }

  function toggleManager(id: string) {
    if (draftManagers.includes(id)) {
      draftManagers = draftManagers.filter((mId) => mId !== id)
    } else {
      draftManagers = [...draftManagers, id]
    }
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

{#snippet seat(node: OrgNode, depth: number)}
  {@const p = node.person}
  {@const extraManagers = managerNames(people, p).slice(1)}
  {@const formId = `seat-form-${p.id}`}
  {@const feedback = feedbackFor(form, 'setPosition', p.id)}
  <li data-testid="org-seat" data-id={p.id} data-kind={p.kind} data-depth={depth}>
    <article class="rounded-lg border border-border bg-card p-3" aria-labelledby="seat-name-{p.id}">
      <div class="flex items-start gap-3">
        <UserAvatar name={p.name} image={p.image ?? null} size="md" testid="org-seat-avatar" />
        <div class="min-w-0 flex-1">
          <h3
            id="seat-name-{p.id}"
            class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold"
          >
            <a
              href={resolve('/(nucleus)/settings/org/[id]', { id: p.id })}
              class="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="org-seat-name">{p.name}</a
            >
            {#if p.kind === 'coworker'}
              <AiMark family={p.modelId ? modelFamily(p.modelId) : null} />
              {#if p.enabled === false}
                <span class="text-xs font-normal text-muted-foreground" data-testid="org-seat-off"
                  >{m.coworkers_off()}</span
                >
              {/if}
            {/if}
            {#if p.id === me.id}<span class="text-xs font-normal text-muted-foreground"
                >{m.org_you()}</span
              >{/if}
          </h3>
          <p class="text-sm text-muted-foreground" data-testid="org-seat-title">
            {p.title ?? m.org_no_title()}
          </p>
          {#if extraManagers.length > 0}
            <p class="mt-0.5 text-xs text-muted-foreground" data-testid="org-seat-also-reports">
              {m.org_also_reports_to({ names: extraManagers.join(', ') })}
            </p>
          {/if}
        </div>
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

      {#if p.accountabilities.length > 0}
        <ul
          class="mt-2 list-disc space-y-0.5 pl-5 text-sm"
          aria-label={m.org_accountabilities_of({ name: p.name })}
          data-testid="org-seat-accountabilities"
        >
          {#each p.accountabilities as a, i (i)}
            <li>{a}</li>
          {/each}
        </ul>
      {/if}

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
            <label class="text-sm font-medium" for="seat-title-{p.id}">{m.org_field_title()}</label>
            <Input
              id="seat-title-{p.id}"
              name="title"
              value={p.title ?? ''}
              required={p.kind === 'coworker'}
              maxlength={120}
            />
          </div>
          <div class="space-y-1">
            <label class="text-sm font-medium" for="seat-acc-{p.id}"
              >{m.org_field_accountabilities()}</label
            >
            <Textarea
              id="seat-acc-{p.id}"
              name="accountabilities"
              value={p.accountabilities.join('\n')}
              rows={3}
              aria-describedby="seat-acc-hint-{p.id}"
            />
            <p id="seat-acc-hint-{p.id}" class="text-xs text-muted-foreground">
              {m.org_accountabilities_hint()}
            </p>
          </div>
          {#if me.canManage}
            <fieldset class="space-y-1.5" data-testid="org-seat-manager">
              <legend class="text-sm font-medium">{m.org_field_reports_to()}</legend>
              <input type="hidden" name="reports_to_sent" value="1" />
              <!-- In the order chosen: the first is the primary manager (the chart's parent). -->
              {#each draftManagers as id (id)}<input type="hidden" name="reports_to_user_ids" value={id} />{/each}
              <div class="flex flex-wrap gap-2">
                {#each managerOptions(people, p.id) as o (o.id)}
                  <label class="flex cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-2.5 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      value={o.id}
                      checked={draftManagers.includes(o.id)}
                      onchange={() => toggleManager(o.id)}
                    />
                    <span>{o.kind === 'coworker' ? m.org_option_coworker({ name: o.name }) : o.name}</span>
                  </label>
                {/each}
              </div>
              <p class="text-xs text-muted-foreground">{m.org_reports_to_multi_hint()}</p>
            </fieldset>
          {/if}
          <div class="flex flex-wrap gap-2">
            <Button type="submit" size="sm" data-testid="org-seat-save">{m.org_save_seat()}</Button>
            <Button type="button" variant="ghost" size="sm" onclick={() => (editing = null)}
              >{m.coworkers_cancel()}</Button
            >
          </div>
        </form>
      {/if}
      {#if feedback}
        <div class="mt-2"><ActionFeedback {feedback} testid="org-seat-feedback" /></div>
      {/if}
    </article>
    {#if node.reports.length > 0}
      <ul
        class="mt-2 ml-3 space-y-2 border-l border-border pl-3 sm:ml-5 sm:pl-5"
        aria-label={m.org_reports_of({ name: p.name })}
      >
        {#each node.reports as child (child.person.id)}
          {@render seat(child, depth + 1)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

{#if tree.length === 0}
  <p class="text-sm text-muted-foreground" data-testid="org-empty">{m.org_empty()}</p>
{:else}
  <ul class="space-y-2" aria-label={m.org_chart_label()} data-testid="org-tree">
    {#each tree as node (node.person.id)}
      {@render seat(node, 0)}
    {/each}
  </ul>
{/if}
