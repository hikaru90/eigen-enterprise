<script lang="ts">
  import type { PageProps } from './$types'
  import { resolve } from '$app/paths'
  import { feedbackFor } from '$lib/coworkers/action-result'
  import CoworkerCard from '$lib/coworkers/coworker-card.svelte'
  import CoworkerCreateForm from '$lib/coworkers/coworker-create-form.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { docTitle } from '$lib/shell/title'

  /**
   * Settings → Co-workers (plan/phase-ai-coworkers.md C5): the company's AI
   * co-workers and a new one from a template. Owner and admins only.
   */
  let { data, form }: PageProps = $props()
</script>

<svelte:head>
  <title>{docTitle(m.coworkers_page_title(), 'Settings')}</title>
</svelte:head>

<div class="space-y-10">
  <header>
    <h2 class="text-base font-semibold tracking-tight">{m.coworkers_page_title()}</h2>
    <p class="mt-1 text-sm text-muted-foreground">
      {m.coworkers_page_intro()}
      <a class="underline underline-offset-4" href={resolve('/settings/org')}>{m.coworkers_see_org_chart()}</a>
    </p>
  </header>

  <section class="space-y-3" aria-labelledby="coworkers-list-heading" data-testid="coworkers-list">
    <h3 id="coworkers-list-heading" class="text-sm font-semibold">{m.coworkers_list_heading()}</h3>
    {#if data.coworkers.length === 0}
      <p class="text-sm text-muted-foreground" data-testid="coworkers-empty">{m.coworkers_empty()}</p>
    {:else}
      <ul class="space-y-2">
        {#each data.coworkers as c (c.id)}
          <CoworkerCard coworker={c} models={data.models} seats={data.seats} {form} rhythms={data.rhythms[c.id]!} timeZone={data.timeZone}
            usage={{ amounts: data.usage.byCoworker[c.id] ?? null, billing: data.usage.billing, period: data.usagePeriod }}
          />
        {/each}
      </ul>
    {/if}
  </section>

  <section class="space-y-3" aria-labelledby="coworkers-new-heading">
    <h3 id="coworkers-new-heading" class="text-sm font-semibold">{m.coworkers_new_heading()}</h3>
    <CoworkerCreateForm
      templates={data.templates}
      models={data.models}
      seats={data.seats}
      feedback={feedbackFor(form, 'create')}
    />
  </section>
</div>
