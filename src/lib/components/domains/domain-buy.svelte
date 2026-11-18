<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import {
    formatEur,
    registryPhone,
    type DomainSearchResult,
    type PurchaseConflict,
    type PurchaseResponse,
  } from '$lib/domains/contract'
  import { countries } from '$lib/domains/countries'
  import type { RegistrantDefaults } from '$lib/domains/registrant-defaults'

  /**
   * Buying a domain (plan/managed-domains.md, the Domain act a): search a name
   * → the available names with their yearly price → the registrant (the
   * company, prefilled with what os knows) → a confirmation that names the
   * price, the yearly renewal and that a registration can't be refunded → buy.
   * The same component on Settings › Domains. The browser only ever talks to
   * os (/api/domains/*); the control plane's token stays on the server.
   */
  let {
    registrant,
    onbought,
  }: {
    registrant: RegistrantDefaults
    /** The purchase was accepted (202): the control plane charges and registers from here. */
    onbought: (detail: PurchaseResponse & { priceCents: number }) => void
  } = $props()

  type Stage = 'search' | 'registrant' | 'confirm'
  let stage = $state<Stage>('search')
  let query = $state('')
  let searching = $state(false)
  let results = $state<DomainSearchResult[] | null>(null)
  let chosen = $state<DomainSearchResult | null>(null)
  let error = $state<string | null>(null)
  let buying = $state(false)

  // The prefill is taken once: the person's edits are theirs.
  // svelte-ignore state_referenced_locally
  const start = registrant
  let firstName = $state(start.firstName)
  let lastName = $state(start.lastName)
  let organization = $state(start.organization)
  let email = $state(start.email)
  let callingCode = $state('+')
  let phone = $state('')
  let addressLine1 = $state('')
  let addressLine2 = $state('')
  let city = $state('')
  let postalCode = $state('')
  let countryCode = $state('')
  let region = $state('')

  const COUNTRIES = countries()
  const price = $derived(chosen?.priceCents != null ? formatEur(chosen.priceCents) : '')

  async function readError(res: Response, fallback: string): Promise<string> {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    return body?.error ?? `${fallback} (HTTP ${res.status}).`
  }

  async function search(): Promise<void> {
    if (searching) return
    searching = true
    error = null
    try {
      const res = await fetch(`/api/domains/search?q=${encodeURIComponent(query.trim())}`)
      if (!res.ok) throw new Error(await readError(res, 'The search failed'))
      const body = (await res.json()) as { results?: DomainSearchResult[] }
      if (!Array.isArray(body.results)) throw new Error('The search answered without results.')
      results = body.results
    } catch (err) {
      results = null
      error = err instanceof Error ? err.message : String(err)
    } finally {
      searching = false
    }
  }

  function choose(r: DomainSearchResult): void {
    chosen = r
    error = null
    stage = 'registrant'
  }

  function toConfirm(): void {
    error = null
    stage = 'confirm'
  }

  async function buy(): Promise<void> {
    if (buying || !chosen || chosen.priceCents == null) return
    buying = true
    error = null
    try {
      const res = await fetch('/api/domains/purchases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: chosen.name,
          acceptedPriceCents: chosen.priceCents,
          registrant: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            organization: organization.trim(),
            email: email.trim(),
            phone: registryPhone(callingCode, phone),
            addressLine1: addressLine1.trim(),
            ...(addressLine2.trim() ? { addressLine2: addressLine2.trim() } : {}),
            city: city.trim(),
            postalCode: postalCode.trim(),
            countryCode,
            ...(region.trim() ? { state: region.trim() } : {}),
          },
        }),
      })
      if (res.status === 409) {
        // Branch on the reason field, never on the words.
        const conflict = (await res.json().catch(() => null)) as PurchaseConflict | null
        if (conflict?.reason === 'price_changed' && conflict.priceCents != null) {
          // Ask again at the new price: the confirmation now names it.
          chosen = { ...chosen, priceCents: conflict.priceCents }
          stage = 'confirm'
          error = `The price of ${chosen.name} changed to ${formatEur(conflict.priceCents)} a year. Buy it at the new price?`
          return
        }
        if (conflict?.reason !== 'taken') throw new Error(conflict?.error ?? 'The domain could not be bought (HTTP 409).')
        // Taken meanwhile: back to fresh results.
        stage = 'search'
        chosen = null
        await search()
        error = conflict.error
        return
      }
      if (res.status !== 202) throw new Error(await readError(res, 'Buying the domain failed'))
      const body = (await res.json()) as PurchaseResponse
      onbought({ ...body, priceCents: chosen.priceCents })
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      buying = false
    }
  }

  const inputClass =
    'focus:border-foreground mt-1 h-10 w-full border-0 border-b border-foreground/25 bg-transparent px-1 text-base text-foreground outline-none disabled:opacity-50'
  const primary =
    'h-11 bg-primary px-8 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
  const quiet = 'text-xs text-muted-foreground hover:text-foreground'
</script>

<div class="w-full text-left" data-testid="domain-buy">
  {#if stage === 'search'}
    <form
      class="flex items-end gap-3"
      onsubmit={(e) => {
        e.preventDefault()
        void search()
      }}
    >
      <label class="flex-1 text-xs text-muted-foreground">
        The name you want
        <input
          bind:value={query}
          type="text"
          required
          autocomplete="off"
          spellcheck="false"
          placeholder="yourcompany"
          class={inputClass}
          disabled={searching}
        />
      </label>
      <button type="submit" class={primary} disabled={searching}>
        {#if searching}<LoaderCircle class="mx-auto size-4 animate-spin" strokeWidth={1.75} />{:else}Search{/if}
      </button>
    </form>
    {#if results}
      {#if results.length === 0}
        <p class="mt-6 text-sm text-muted-foreground" role="status">
          No endings are offered for that name. Try another one.
        </p>
      {:else}
        <ul class="mt-6 divide-y divide-border border-y border-border" data-testid="domain-results">
          {#each results as r (r.name)}
            <li class="flex items-center justify-between gap-4 py-3">
              <span class="min-w-0 truncate text-sm font-medium">{r.name}</span>
              {#if r.available && r.priceCents != null}
                <span class="flex items-center gap-4">
                  <span class="text-sm tabular-nums text-muted-foreground">{formatEur(r.priceCents)} / year</span>
                  <button
                    type="button"
                    class="text-sm font-medium underline-offset-4 hover:underline"
                    aria-label={`Choose ${r.name}`}
                    onclick={() => choose(r)}
                  >
                    Choose
                  </button>
                </span>
              {:else}
                <span class="text-sm text-muted-foreground">{r.available ? 'Not offered' : 'Taken'}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {:else if stage === 'registrant' && chosen}
    <p class="text-sm">
      <span class="font-medium">{chosen.name}</span> is registered to the company. Registries need a
      contact for it; privacy protection keeps these details out of public lookups.
    </p>
    <form
      class="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2"
      data-testid="domain-registrant"
      onsubmit={(e) => {
        e.preventDefault()
        toConfirm()
      }}
    >
      <label class="text-xs text-muted-foreground">
        First name
        <input bind:value={firstName} required autocomplete="given-name" class={inputClass} />
      </label>
      <label class="text-xs text-muted-foreground">
        Last name
        <input bind:value={lastName} required autocomplete="family-name" class={inputClass} />
      </label>
      <label class="text-xs text-muted-foreground sm:col-span-2">
        Company
        <input bind:value={organization} required autocomplete="organization" class={inputClass} />
      </label>
      <label class="text-xs text-muted-foreground sm:col-span-2">
        Email
        <input bind:value={email} type="email" required autocomplete="email" class={inputClass} />
      </label>
      <label class="text-xs text-muted-foreground">
        Phone country code
        <input
          bind:value={callingCode}
          required
          inputmode="tel"
          pattern={'\\+?[0-9]{1,3}'}
          placeholder="+49"
          class={inputClass}
        />
      </label>
      <label class="text-xs text-muted-foreground">
        Phone number
        <input
          bind:value={phone}
          type="tel"
          required
          autocomplete="tel-national"
          placeholder="30 1234567"
          class={inputClass}
        />
      </label>
      <label class="text-xs text-muted-foreground sm:col-span-2">
        Street and number
        <input bind:value={addressLine1} required autocomplete="address-line1" class={inputClass} />
      </label>
      <label class="text-xs text-muted-foreground sm:col-span-2">
        Address line 2 (optional)
        <input bind:value={addressLine2} autocomplete="address-line2" class={inputClass} />
      </label>
      <label class="text-xs text-muted-foreground">
        Postal code
        <input bind:value={postalCode} required autocomplete="postal-code" class={inputClass} />
      </label>
      <label class="text-xs text-muted-foreground">
        City
        <input bind:value={city} required autocomplete="address-level2" class={inputClass} />
      </label>
      <label class="text-xs text-muted-foreground">
        Country
        <select bind:value={countryCode} required class={inputClass}>
          <option value="" disabled>Choose…</option>
          {#each COUNTRIES as c (c.code)}
            <option value={c.code}>{c.name}</option>
          {/each}
        </select>
      </label>
      <label class="text-xs text-muted-foreground">
        State or region (optional)
        <input bind:value={region} autocomplete="address-level1" class={inputClass} />
      </label>
      <div class="flex items-center justify-between gap-4 sm:col-span-2">
        <button type="button" class={quiet} onclick={() => (stage = 'search')}>← Another name</button>
        <button type="submit" class={primary}>Continue</button>
      </div>
    </form>
  {:else if stage === 'confirm' && chosen}
    <div data-testid="domain-confirm">
      <p class="text-base">
        <span class="font-medium">{chosen.name}</span> costs {price} a year.
      </p>
      <ul class="mt-4 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>{price} is charged now to the company’s card.</li>
        <li>It renews every year at {price}, charged to the same card.</li>
        <li>A registration can’t be refunded. If the registration itself fails, the charge is refunded in full.</li>
        <li>It is registered to {organization.trim()}; the company owns it.</li>
      </ul>
      <div class="mt-8 flex items-center justify-between gap-4">
        <button type="button" class={quiet} disabled={buying} onclick={() => (stage = 'registrant')}>
          ← Change details
        </button>
        <button type="button" class={primary} disabled={buying} onclick={() => void buy()}>
          {#if buying}<LoaderCircle class="mx-auto size-4 animate-spin" strokeWidth={1.75} />{:else}Buy for {price} / year{/if}
        </button>
      </div>
    </div>
  {/if}
  {#if error}
    <p class="text-destructive mt-4 text-sm leading-relaxed" role="alert">{error}</p>
  {/if}
</div>
