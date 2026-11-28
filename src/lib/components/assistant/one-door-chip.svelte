<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- the href arrives from memory.route_input
     (an app path with a query, built server-side by intakeItemHref), not a route literal */
  import type { InputRoute, OneDoor } from './one-door.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { ROUTES } from './one-door.svelte'

  /**
   * The one door's chip under the Ask bar (plan/concept-memory-one-door.md §2.1): what the brain
   * did with the words — "Saved as task · Open · Change" — or, when unsure, the choices to pick
   * from, or why it failed with the words kept to try again. One tap corrects it.
   */
  let { door }: { door: OneDoor } = $props()

  let changing = $state(false)

  const label = (r: InputRoute) =>
    ({
      question: m.one_door_route_question(),
      remember: m.one_door_route_remember(),
      task: m.one_door_route_task(),
      document: m.one_door_route_document(),
      reminder: m.one_door_route_reminder(),
    })[r]

  function pick(route: InputRoute): void {
    changing = false
    void door.choose(route)
  }

  function retry(text: string): void {
    void door.submit(text)
  }
</script>

{#if door.state.kind !== 'idle'}
  <div
    class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground shadow-sm"
    role="status"
    aria-live="polite"
    data-testid="one-door-chip"
    data-state={door.state.kind}
  >
    {#if door.state.kind === 'routing'}
      <span class="text-muted-foreground">{m.one_door_routing()}</span>
    {:else if door.state.kind === 'filed'}
      <span>{m.one_door_filed({ route: label(door.state.route) })}</span>
      <a class="underline-offset-2 hover:underline" href={door.state.url} data-testid="one-door-open">{m.one_door_open()}</a>
      <button type="button" class="underline-offset-2 hover:underline" onclick={() => (changing = !changing)} data-testid="one-door-change">
        {m.one_door_change()}
      </button>
      {#if changing}
        {@const current = door.state.route}
        {#each ROUTES.filter((r) => r !== current) as r (r)}
          <button type="button" class="chip chip-line" onclick={() => pick(r)} data-testid="one-door-choice-{r}">{label(r)}</button>
        {/each}
      {/if}
    {:else if door.state.kind === 'unsure'}
      <span>{m.one_door_unsure()}</span>
      {#each door.state.choices as r (r)}
        <button type="button" class="chip chip-line" onclick={() => pick(r)} data-testid="one-door-choice-{r}">{label(r)}</button>
      {/each}
    {:else if door.state.kind === 'failed'}
      {@const text = door.state.text}
      <span class="text-destructive" data-testid="one-door-error">{m.one_door_failed({ error: door.state.error })}</span>
      <button type="button" class="underline-offset-2 hover:underline" onclick={() => retry(text)}>{m.one_door_retry()}</button>
    {/if}
    {#if door.state.kind !== 'routing'}
      <button type="button" class="ml-auto text-muted-foreground hover:text-foreground" onclick={() => door.dismiss()} aria-label={m.one_door_dismiss()}>×</button>
    {/if}
  </div>
{/if}
