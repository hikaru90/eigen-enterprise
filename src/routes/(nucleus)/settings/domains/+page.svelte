<script lang="ts">
  import type { PageProps } from './$types'
  import { invalidateAll } from '$app/navigation'
  import DomainBuy from '$lib/components/domains/domain-buy.svelte'
  import DomainConnect from '$lib/components/domains/domain-connect.svelte'
  import DomainProgress from '$lib/components/domains/domain-progress.svelte'
  import DomainSection from '$lib/components/domains/domain-section.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import { EMPTY_REGISTRANT } from '$lib/domains/registrant-defaults'
  import { shownErrorOf } from '$lib/errors/agent-report'
  import { docTitle } from '$lib/shell/title'

  /**
   * Settings › Domains — the one place (plan/domains-one-claim.md): every
   * domain the company has, each hostname under it with what it shows, its
   * email, DNS, claim and certificate, and the records still to add. Domains
   * are a global setting edited only here; the company website, apps and
   * Email show their address and link here. "Buy a domain" (managed boxes)
   * and "Connect one you have" stay as they were.
   */
  let { data, form }: PageProps = $props()

  let panel = $state<'buy' | 'connect' | null>(null)
  /** A purchase just made here: its progress shows until it is ready. */
  let buying = $state<string | null>(null)

  const list = $derived(data.list)
  const answer = $derived.by(() => {
    if (!form || !('action' in form)) return null
    const failed = shownErrorOf(form)
    if (failed) return { kind: 'error' as const, ...failed }
    const f = form as { message?: string; reconcileError?: string | null }
    if (f.reconcileError)
      return {
        kind: 'error' as const,
        error: `${f.message ?? 'Saved.'} The server could not apply it yet: ${f.reconcileError}`,
        agent: null,
      }
    return { kind: 'ok' as const, text: f.message ?? 'Done.' }
  })

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
  The company’s addresses on the internet. Each address shows one thing — the console, the company
  website, an app, calls, or nothing — and email rides along on the same names. This is the one
  place to change them.
</p>

{#if data.listError}
  <ErrorNotice class="mt-4" error={data.listError.error} agent={data.listError.agent} />
{/if}
{#each list?.errors ?? [] as e (e.source)}
  <ErrorNotice class="mt-4" error={e.error} agent={e.agent} testid={`domains-error-${e.source}`} />
{/each}
{#if list && !list.managed && list.reason}
  <p class="mt-4 text-xs text-muted-foreground" data-testid="domains-unmanaged">
    What each address shows is set on a server with ee, its deploy agent: {list.reason}
  </p>
{/if}

{#if answer}
  <div class="mt-4" role="status" data-testid="domains-answer">
    {#if answer.kind === 'ok'}
      <p class="text-sm">{answer.text}</p>
    {:else}
      <ErrorNotice error={answer.error} agent={answer.agent} />
    {/if}
  </div>
{/if}

<div data-testid="settings-domains">
  {#if list && list.domains.length === 0}
    <p class="mt-8 rounded-lg border border-border px-4 py-6 text-sm text-muted-foreground">
      No domains yet.
    </p>
  {/if}
  {#each list?.domains ?? [] as d (d.name)}
    <DomainSection
      domain={d}
      managed={list?.managed ?? false}
      apps={list?.apps ?? []}
      mailNote={data.mailNotes[d.name] ?? null}
    />
  {/each}
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
    <p class="mb-3 text-xs text-muted-foreground" data-testid="domains-connect-note">
      Connecting a domain adds it for email; add hostnames below to use it for the website or apps.
    </p>
    <DomainConnect onconnected={() => void invalidateAll()} />
  </div>
{/if}
