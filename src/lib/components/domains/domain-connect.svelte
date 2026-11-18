<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import DnsRecordsTable from '$lib/components/email/dns-records-table.svelte'
  import DnsStatus from '$lib/components/email/dns-status.svelte'
  import type { ConnectedDomain } from '$lib/domains/connected'

  /**
   * "I already have one" (plan/managed-domains.md, the Domain act b): enter
   * the domain; it becomes the company's mail domain and its DNS records show
   * in the one records view, with a check. The records go into the company's
   * own DNS (DM4): nothing is written there for it.
   */
  let {
    onconnected,
  }: {
    /** Added (and on every check): the domain with its records. */
    onconnected?: (domain: ConnectedDomain) => void
  } = $props()

  let name = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let domain = $state<ConnectedDomain | null>(null)

  async function post(url: string, body?: unknown): Promise<void> {
    if (busy) return
    busy = true
    error = null
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const out = (await res.json().catch(() => null)) as { domain?: ConnectedDomain; error?: string } | null
      if (!res.ok) throw new Error(out?.error ?? `That did not work (HTTP ${res.status}).`)
      if (!out?.domain) throw new Error('The server answered without the domain.')
      domain = out.domain
      onconnected?.(out.domain)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  const inputClass =
    'focus:border-foreground mt-1 h-10 w-full border-0 border-b border-foreground/25 bg-transparent px-1 text-base text-foreground outline-none disabled:opacity-50'
</script>

<div class="w-full text-left" data-testid="domain-connect">
  {#if !domain}
    <form
      class="flex items-end gap-3"
      onsubmit={(e) => {
        e.preventDefault()
        void post('/api/domains/connected', { name: name.trim() })
      }}
    >
      <label class="flex-1 text-xs text-muted-foreground">
        Your domain
        <input
          bind:value={name}
          type="text"
          required
          autocomplete="off"
          spellcheck="false"
          placeholder="yourcompany.com"
          class={inputClass}
          disabled={busy}
        />
      </label>
      <button
        type="submit"
        class="h-11 bg-primary px-8 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        disabled={busy}
      >
        {#if busy}<LoaderCircle class="mx-auto size-4 animate-spin" strokeWidth={1.75} />{:else}Add{/if}
      </button>
    </form>
  {:else}
    <div class="flex flex-wrap items-center gap-3">
      <p class="text-base font-medium" data-testid="connected-domain-name">{domain.name}</p>
      <DnsStatus status={domain.status} />
    </div>
    <p class="mt-1 text-sm text-muted-foreground">
      {#if domain.sendable}
        Verified — mail can go out from any address at {domain.name}.
      {:else}
        Add these records where you manage {domain.name}’s DNS (where you bought it, or Cloudflare, Route 53 …).
        They are checked again every few minutes; DNS changes can take a few hours to appear.
      {/if}
    </p>
    {#if domain.errorMessage}
      <p class="mt-2 text-sm text-muted-foreground" data-testid="connected-domain-note">{domain.errorMessage}</p>
    {/if}
    {#if domain.records.length > 0}
      <div class="mt-4">
        <DnsRecordsTable domain={domain.name} records={domain.records} />
      </div>
    {/if}
    <button
      type="button"
      class="mt-4 text-sm font-medium underline-offset-4 hover:underline disabled:opacity-50"
      disabled={busy}
      onclick={() => domain && void post(`/api/domains/connected/${domain.id}/check`)}
    >
      {#if busy}<LoaderCircle class="inline size-4 animate-spin" strokeWidth={1.75} />{:else}Check the records now{/if}
    </button>
  {/if}
  {#if error}
    <p class="text-destructive mt-4 text-sm leading-relaxed" role="alert">{error}</p>
  {/if}
</div>
