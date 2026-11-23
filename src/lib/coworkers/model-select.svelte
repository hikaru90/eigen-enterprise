<script lang="ts">
  import type { ChatModelOption } from './model-family'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * The model picker (plan/phase-ai-coworkers.md §5): the pool's chat models,
   * each named with its family, and the pool's line on the chosen one below.
   */
  let {
    id,
    models,
    value = $bindable(''),
    name = 'model_id',
    testid = 'coworker-model',
  }: { id: string; models: ChatModelOption[]; value?: string; name?: string; testid?: string } = $props()

  const chosen = $derived(models.find((o) => o.id === value) ?? null)
</script>

<select
  {id}
  {name}
  bind:value
  required
  class="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
  aria-describedby="{id}-note"
  data-testid={testid}
>
  {#if !chosen}<option value="" disabled>{m.coworkers_pick_model()}</option>{/if}
  {#each models as o (o.id)}
    <option value={o.id}>{o.family} · {o.name}{o.recommended ? ` (${m.coworkers_model_recommended()})` : ''}</option>
  {/each}
</select>
<p id="{id}-note" class="text-xs text-muted-foreground" data-testid="{testid}-note">{chosen?.note ?? ''}</p>
