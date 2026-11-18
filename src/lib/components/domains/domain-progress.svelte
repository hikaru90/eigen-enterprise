<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { onMount } from 'svelte'
  import type { BoughtDomain, DomainState } from '$lib/domains/contract'

  /**
   * A bought domain on its way (plan/managed-domains.md): paid → registered →
   * DNS and email set up → ready. It reads os's /api/domains every few seconds
   * until the domain is active or failed, and says so with explicit events.
   */
  let {
    name,
    pollMs = 5000,
    onactive,
    onfailed,
  }: {
    name: string
    pollMs?: number
    onactive?: () => void
    onfailed?: (error: string) => void
  } = $props()

  const STEPS: { state: Exclude<DomainState, 'failed'>; label: string }[] = [
    { state: 'charging', label: 'Payment' },
    { state: 'registering', label: 'Registration' },
    { state: 'configuring', label: 'DNS and email records' },
    { state: 'active', label: 'Ready' },
  ]
  const ORDER: Record<DomainState, number> = { charging: 0, registering: 1, configuring: 2, active: 3, failed: -1 }

  let domain = $state<BoughtDomain | null>(null)
  let error = $state<string | null>(null)
  const current = $derived(domain ? ORDER[domain.state] : 0)

  onMount(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    async function poll(): Promise<void> {
      try {
        const res = await fetch('/api/domains')
        const body = (await res.json().catch(() => null)) as { domains?: BoughtDomain[]; error?: string } | null
        if (!res.ok) throw new Error(body?.error ?? `Reading the domain’s state failed (HTTP ${res.status}).`)
        if (!Array.isArray(body?.domains)) throw new Error('The domain list came back empty-handed.')
        const found = body.domains.find((d) => d.name === name)
        if (!found) throw new Error(`${name} is not in the company’s domains (yet). Try again in a moment.`)
        error = null
        domain = found
        if (found.state === 'active') return onactive?.()
        if (found.state === 'failed') return onfailed?.(found.error ?? 'The registration failed.')
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      if (!stopped) timer = setTimeout(() => void poll(), pollMs)
    }
    void poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  })
</script>

<div class="w-full text-left" data-testid="domain-progress">
  <p class="text-base"><span class="font-medium">{name}</span></p>
  {#if domain?.state === 'failed'}
    <p class="text-destructive mt-4 text-sm leading-relaxed" role="alert" data-testid="domain-failed">
      {domain.error ?? 'The registration failed.'} Nothing stays charged for a failed registration.
    </p>
  {:else}
    <ol class="mt-4 space-y-2.5" aria-label="Progress">
      {#each STEPS as step, i (step.state)}
        <li
          class="flex items-center gap-3 text-sm {i <= current ? 'text-foreground' : 'text-muted-foreground'}"
          data-testid={`domain-step-${step.state}`}
          data-done={i < current || domain?.state === 'active'}
        >
          {#if i < current || domain?.state === 'active'}
            <Check class="size-4" strokeWidth={1.75} aria-hidden="true" />
          {:else if i === current}
            <LoaderCircle class="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
          {:else}
            <span class="size-4" aria-hidden="true"></span>
          {/if}
          {step.label}
        </li>
      {/each}
    </ol>
    <p class="mt-4 text-xs text-muted-foreground" role="status">
      {domain?.state === 'active'
        ? `${name} is ready.`
        : 'This takes a few minutes. It finishes on its own; nothing to do in your DNS.'}
    </p>
  {/if}
  {#if error}
    <p class="text-destructive mt-3 text-sm leading-relaxed" role="alert">{error}</p>
  {/if}
</div>
