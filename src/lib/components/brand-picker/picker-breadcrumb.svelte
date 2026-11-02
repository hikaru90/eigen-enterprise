<script lang="ts">
  import { resolve } from '$app/paths'
  import { pickerQuery, type PickerCard } from './types'

  /** Root → current node; every ancestor steps back (plain links, so browser back/forward work). */
  let { trail }: { trail: PickerCard[] } = $props()
</script>

<nav aria-label="Style path">
  <ol class="text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm">
    <li>
      {#if trail.length === 0}
        <span aria-current="page" class="text-foreground font-medium">All styles</span>
      {:else}
        <a class="hover:text-foreground underline-offset-4 hover:underline" href={resolve('/brand')}>All styles</a>
      {/if}
    </li>
    {#each trail as node, i (node.id)}
      <li aria-hidden="true">›</li>
      <li>
        {#if i === trail.length - 1}
          <span aria-current="page" class="text-foreground font-medium">{node.name}</span>
        {:else}
          <a class="hover:text-foreground underline-offset-4 hover:underline" href={resolve(`/brand${pickerQuery(node.id)}` as '/brand')}>{node.name}</a>
        {/if}
      </li>
    {/each}
  </ol>
</nav>
