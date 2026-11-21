<script lang="ts" module>
  /**
   * Mine / Team on Memory › Projects and Notes (plan/shared-memory-voice-agent-tools.md §1):
   * the person's own items, or what colleagues share with everyone. View
   * state only; the caller loads the chosen scope.
   */
  export type MemoryScope = 'mine' | 'team'
</script>

<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'

  let { scope, onselect }: { scope: MemoryScope; onselect: (next: MemoryScope) => void } = $props()

  const options: Array<{ value: MemoryScope; label: string }> = [
    { value: 'mine', label: m.memory_scope_mine() },
    { value: 'team', label: m.memory_scope_team() },
  ]

  const pillClass = (active: boolean) =>
    active
      ? 'rounded-md bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground'
      : 'rounded-md px-3 py-1 text-xs text-muted-foreground hover:text-foreground'
</script>

<div
  class="border-border flex w-fit items-center gap-0.5 rounded-full border bg-muted/20 p-0.5"
  role="tablist"
  aria-label={m.memory_scope_aria()}
  data-testid="memory-scope-tabs"
>
  {#each options as option (option.value)}
    <button
      type="button"
      role="tab"
      class={pillClass(scope === option.value)}
      aria-selected={scope === option.value}
      onclick={() => {
        if (scope !== option.value) onselect(option.value)
      }}
    >
      {option.label}
    </button>
  {/each}
</div>
