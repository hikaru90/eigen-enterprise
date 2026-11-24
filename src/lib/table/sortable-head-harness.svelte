<script lang="ts">
  import { nextSort, sortRows, type SortState } from './sort'
  import SortableHead from './sortable-head.svelte'

  const rows = ['b', 'c', 'a']
  type K = 'name' | 'other'
  let sort = $state<SortState<K>>(null)
  const shown = $derived(
    sortRows(rows, sort, { name: (r: string) => r, other: (r: string) => r.length }),
  )
</script>

<table>
  <thead>
    <tr>
      <SortableHead label="Name" sortKey="name" {sort} onsort={(k) => (sort = nextSort(sort, k))} />
      <SortableHead
        label="Other"
        sortKey="other"
        {sort}
        onsort={(k) => (sort = nextSort(sort, k))}
      />
    </tr>
  </thead>
  <tbody>
    {#each shown as r (r)}<tr><td>{r}</td></tr>{/each}
  </tbody>
</table>
