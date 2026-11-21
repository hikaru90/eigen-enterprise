<script lang="ts">
  import type { PageProps } from './$types'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import DomainBuy from '$lib/components/domains/domain-buy.svelte'
  import DomainConnect from '$lib/components/domains/domain-connect.svelte'
  import DomainProgress from '$lib/components/domains/domain-progress.svelte'
  import DnsStatus from '$lib/components/email/dns-status.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import { STATE_LABEL } from '$lib/domains/contract'
  import { EMPTY_REGISTRANT } from '$lib/domains/registrant-defaults'
  import { docTitle } from '$lib/shell/title'

  /**
   * Settings › Domains (plan/managed-domains.md): the company's domains with
   * their state and renewal, "Buy a domain" on managed boxes and "Connect one
   * you have" — the same components as the onboarding's Domain act.
   */
  let { data }: PageProps = $props()

  let panel = $state<'buy' | 'connect' | null>(null)
  /** A purchase just made here: its progress shows until it is ready. */
  let buying = $state<string | null>(null)

  const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

  function onBought(detail: { name: string }): void {
    panel = null
    buying = detail.name
    void invalidateAll()
  }

  function onSettled(): void {
    buying = null
    void invalidateAll()
  }
</script>

<svelte:head>
  <title>{docTitle('Domains', 'Settings')}</title>
</svelte:head>

<h2 class="text-base font-semibold tracking-tight">Domains</h2>
<p class="mt-1 text-sm text-foreground/60">
  The company’s addresses on the internet: email goes out from them, and later the website lives on
  them.
</p>

{#if data.boughtError}
  <ErrorNotice class="mt-4" {...data.boughtError} />
{/if}

<div class="mt-8 rounded-lg border border-border" data-testid="settings-domains">
  {#if data.rows.length === 0}
    <p class="px-4 py-6 text-sm text-muted-foreground">No domains yet.</p>
  {:else}
    <ul class="divide-y divide-border">
      {#each data.rows as row (row.name)}
        <li
          class="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
          data-testid="domain-row"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">{row.name}</p>
            <p class="mt-0.5 text-xs text-muted-foreground">
              {#if row.source === 'bought'}
                Bought through eigenEnterprise
                {#if row.renewsAt}
                  · {row.autoRenew
                    ? `Renews ${date(row.renewsAt)}`
                    : `Runs out ${date(row.renewsAt)} (renewal off)`}
                {/if}
              {:else}
                In your own DNS
              {/if}
            </p>
            {#if row.error}<ErrorNotice
                class="mt-1 text-xs"
                error={row.error}
                attempted={`Registering the bought domain ${row.name} (the control plane reported it failed)`}
              />{/if}
            {#if row.mailNote}<p class="mt-1 text-xs text-muted-foreground">{row.mailNote}</p>{/if}
          </div>
          <div class="flex shrink-0 items-center gap-3">
            {#if row.state}
              <span class="text-xs text-muted-foreground" data-testid="domain-state"
                >{STATE_LABEL[row.state]}</span
              >
            {/if}
            {#if row.mail}
              <DnsStatus status={row.mail.status} />
              <a
                class="text-xs underline-offset-4 hover:underline"
                href={resolve(`/m/email/domains/${row.mail.id}`)}>DNS records</a
              >
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

{#if buying}
  <div class="mt-6 rounded-lg border border-border p-4">
    <DomainProgress name={buying} onactive={onSettled} onfailed={onSettled} />
  </div>
{/if}

<div class="mt-6 flex flex-wrap gap-3">
  {#if data.canBuy}
    <Button
      variant={panel === 'buy' ? 'default' : 'outline'}
      onclick={() => (panel = panel === 'buy' ? null : 'buy')}
      data-testid="domains-buy">Buy a domain</Button
    >
  {/if}
  <Button
    variant={panel === 'connect' ? 'default' : 'outline'}
    onclick={() => (panel = panel === 'connect' ? null : 'connect')}
    data-testid="domains-connect">Connect one you have</Button
  >
</div>
{#if !data.canBuy}
  <p class="mt-2 text-xs text-muted-foreground">
    Buying a domain works on servers hosted by eigenEnterprise.
  </p>
{/if}

{#if panel === 'buy'}
  <div class="mt-6 rounded-lg border border-border p-4">
    <DomainBuy registrant={data.registrant ?? EMPTY_REGISTRANT} onbought={onBought} />
  </div>
{:else if panel === 'connect'}
  <div class="mt-6 rounded-lg border border-border p-4">
    <DomainConnect onconnected={() => void invalidateAll()} />
  </div>
{/if}
