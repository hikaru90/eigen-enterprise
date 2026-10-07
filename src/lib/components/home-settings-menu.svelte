<script lang="ts">
  import Cpu from '@lucide/svelte/icons/cpu'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw'
  import Settings from '@lucide/svelte/icons/settings'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import * as Popover from '$lib/components/ui/popover'

  /**
   * The homepage's settings entry point: a cog in the header, always reachable
   * (chat, welcome wizard, and provider gate alike). API keys, provider and
   * app settings live on their pages; restarting onboarding clears the welcome
   * stamp and reloads page data so the wizard takes over the homepage again.
   */

  let menuOpen = $state(false)
  let restarting = $state(false)
  let error = $state<string | null>(null)

  async function restartOnboarding(): Promise<void> {
    if (restarting) return
    restarting = true
    error = null
    try {
      const res = await fetch('/api/onboarding/welcome/reset', { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Restarting onboarding failed (HTTP ${res.status}).`)
      }
      await invalidateAll()
      menuOpen = false
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      restarting = false
    }
  }
</script>

<Popover.Root bind:open={menuOpen}>
  <Popover.Trigger
    class="text-muted-foreground hover:text-foreground flex size-8 cursor-pointer items-center justify-center rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
    aria-label="Settings menu"
    data-testid="home-settings-trigger"
  >
    <Settings class="pointer-events-none size-5 shrink-0" aria-hidden="true" strokeWidth={1.75} />
  </Popover.Trigger>
  <Popover.Content align="end" side="bottom" sideOffset={6} class="w-56 gap-1 overflow-hidden pt-2 pb-2">
    <a
      href={resolve('/api-keys')}
      class="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm text-foreground hover:bg-white/25 dark:hover:bg-white/10"
    >
      <KeyRound class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
      API Keys
    </a>
    <a
      href={resolve('/settings/llm')}
      class="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm text-foreground hover:bg-white/25 dark:hover:bg-white/10"
    >
      <Cpu class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
      AI provider
    </a>
    <a
      href={resolve('/settings')}
      class="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm text-foreground hover:bg-white/25 dark:hover:bg-white/10"
    >
      <Settings class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
      Settings
    </a>
    <div class="bg-border my-1 h-px"></div>
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-white/25 disabled:opacity-50 dark:hover:bg-white/10"
      disabled={restarting}
      onclick={() => void restartOnboarding()}
      data-testid="restart-onboarding"
    >
      {#if restarting}
        <LoaderCircle class="size-4 shrink-0 animate-spin" strokeWidth={1.75} />
      {:else}
        <RotateCcw class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
      {/if}
      Restart onboarding
    </button>
    {#if error}
      <p class="text-destructive mt-1 px-2 text-xs leading-relaxed" role="alert">
        {error}
      </p>
    {/if}
  </Popover.Content>
</Popover.Root>
