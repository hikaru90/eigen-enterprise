<script lang="ts">
  import type { PageData } from './$types'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import { resolve } from '$app/paths'
  import { m } from '$lib/paraglide/messages.js'
  import { docTitle } from '$lib/shell/title'
  import BrainIntakeView from './brain-intake.svelte'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>{docTitle(m.memory_intake_title(), 'Memory')}</title></svelte:head>

<div class="w-full min-w-0 px-4 pt-6 pb-10 sm:px-8" data-testid="memory-intake-page">
  <a
    href={resolve('/m/memory/capture')}
    class="mb-3 inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    data-testid="intake-back"
  >
    <ArrowLeft class="size-3.5" aria-hidden="true" />
    {m.memory_intake_back()}
  </a>
  <h2 class="mb-1 text-base font-semibold text-foreground">{m.memory_intake_title()}</h2>
  <p class="mb-4 max-w-[65ch] text-sm text-muted-foreground">{m.memory_intake_line()}</p>
  <BrainIntakeView intake={data.intake} limit={data.limit} />
</div>
