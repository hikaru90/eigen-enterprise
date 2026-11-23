<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import type { PageProps } from './$types'
  import { resolve } from '$app/paths'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import AiMark from '$lib/coworkers/ai-mark.svelte'
  import MessageButton from '$lib/coworkers/message-button.svelte'
  import { modelFamily, modelName } from '$lib/coworkers/model-family'
  import { m } from '$lib/paraglide/messages.js'
  import { docTitle } from '$lib/shell/title'

  /**
   * A seat's profile (plan/phase-ai-coworkers.md C5): the role card, and for an
   * AI co-worker its lens, model and the person it answers to. "Message" opens
   * the DM. The run log comes with coworkers.runs (C3).
   */
  let { data }: PageProps = $props()

  const p = $derived(data.person)
  const c = $derived(data.coworker)
  const family = $derived(c ? modelFamily(c.modelId) : null)
  const profileHref = (id: string) => resolve('/(nucleus)/settings/org/[id]', { id })
</script>

<svelte:head>
  <title>{docTitle(p.name, m.org_page_title())}</title>
</svelte:head>

<div class="max-w-2xl space-y-6" data-testid="seat-profile" data-kind={p.kind}>
  <a
    href={resolve('/settings/org')}
    class="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    ><ArrowLeft class="size-4" aria-hidden="true" />{m.org_back_to_chart()}</a
  >

  <header class="flex items-start gap-4">
    <UserAvatar name={p.name} size="lg" />
    <div class="min-w-0 flex-1 space-y-1">
      <h2 class="flex flex-wrap items-center gap-2 text-base font-semibold tracking-tight">
        <span>{p.name}</span>
        {#if p.kind === 'coworker'}<AiMark {family} />{/if}
        {#if c && !c.enabled}<span class="text-sm font-normal text-muted-foreground">{m.coworkers_off()}</span>{/if}
      </h2>
      <p class="text-sm text-muted-foreground" data-testid="profile-title">{p.title ?? m.org_no_title()}</p>
    </div>
  </header>

  {#if p.id !== data.me.id}
    <MessageButton userId={p.id} name={p.name} />
  {/if}

  <section class="rounded-lg border border-border bg-card p-4" aria-labelledby="role-card">
    <h3 id="role-card" class="text-sm font-semibold">{m.coworkers_role_card()}</h3>
    <dl class="mt-3 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
      <dt class="font-medium">{m.org_field_accountabilities()}</dt>
      <dd>
        {#if p.accountabilities.length > 0}
          <ul class="list-disc space-y-0.5 pl-5" data-testid="profile-accountabilities">
            {#each p.accountabilities as a, i (i)}<li>{a}</li>{/each}
          </ul>
        {:else}
          <span class="text-muted-foreground">{m.org_no_accountabilities()}</span>
        {/if}
      </dd>

      <dt class="font-medium">{m.org_field_reports_to()}</dt>
      <dd data-testid="profile-manager">
        {#if data.manager}
          <a class="underline-offset-4 hover:underline" href={profileHref(data.manager.id)}>{data.manager.name ?? data.manager.id}</a>
        {:else}
          <span class="text-muted-foreground">{m.org_reports_to_nobody()}</span>
        {/if}
      </dd>

      {#if data.reports.length > 0}
        <dt class="font-medium">{m.org_direct_reports()}</dt>
        <dd>
          <ul class="space-y-0.5">
            {#each data.reports as r (r.id)}
              <li class="flex items-center gap-2">
                <a class="underline-offset-4 hover:underline" href={profileHref(r.id)}>{r.name}</a>
                {#if r.kind === 'coworker'}<AiMark />{/if}
              </li>
            {/each}
          </ul>
        </dd>
      {/if}

      {#if c}
        <dt class="font-medium">{m.coworkers_accountable_human()}</dt>
        <dd data-testid="profile-accountable">
          {#if c.accountableHuman}
            <a class="underline-offset-4 hover:underline" href={profileHref(c.accountableHuman.id)}>{c.accountableHuman.name}</a>
          {/if}
          <p class="text-xs text-muted-foreground">{m.coworkers_accountable_hint()}</p>
        </dd>

        <dt class="font-medium">{m.coworkers_field_model()}</dt>
        <dd data-testid="profile-model">{family} · <span class="font-mono text-xs">{modelName(c.modelId)}</span></dd>

        <dt class="font-medium">{m.coworkers_field_daily_cap()}</dt>
        <dd>{m.coworkers_daily_cap_value({ amount: c.dailyCapUsd.toFixed(2) })}</dd>

        <dt class="font-medium">{m.coworkers_field_lens()}</dt>
        <dd class="whitespace-pre-line" data-testid="profile-lens">{c.lens}</dd>
      {/if}
    </dl>
  </section>

  {#if p.kind === 'coworker' && data.me.canManage}
    <p class="text-sm">
      <a class="underline underline-offset-4" href={resolve('/settings/coworkers')} data-testid="profile-manage"
        >{m.coworkers_manage_link()}</a
      >
    </p>
  {/if}
</div>
