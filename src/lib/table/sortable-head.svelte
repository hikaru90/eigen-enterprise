<script lang="ts" generics="K extends string">
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down'
  import { m } from '$lib/paraglide/messages.js'
  import { ariaSort, type SortState } from './sort'

  let {
    label,
    sortKey,
    sort,
    onsort,
    class: className = '',
  }: {
    label: string
    sortKey: K
    sort: SortState<K>
    onsort: (key: K) => void
    class?: string
  } = $props()

  const dir = $derived(ariaSort(sort, sortKey))
</script>

<th scope="col" class={className} aria-sort={dir}>
  <button
    type="button"
    class="inline-flex items-center gap-1 font-medium hover:text-foreground"
    title={m.table_sort_by({ column: label })}
    onclick={() => onsort(sortKey)}
  >
    {label}
    {#if dir === 'ascending'}
      <ArrowUp class="size-3" aria-hidden="true" />
    {:else if dir === 'descending'}
      <ArrowDown class="size-3" aria-hidden="true" />
    {:else}
      <ArrowUpDown class="size-3 opacity-40" aria-hidden="true" />
    {/if}
  </button>
</th>
