<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import LogOut from '@lucide/svelte/icons/log-out'
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw'
  import Settings from '@lucide/svelte/icons/settings'
  import Speech from '@lucide/svelte/icons/speech'
  import Volume2 from '@lucide/svelte/icons/volume-2'
  import VolumeX from '@lucide/svelte/icons/volume-x'
  import { goto, invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import * as Popover from '$lib/components/ui/popover'
  import { isSoundEnabled, setSoundEnabled } from '$lib/sound/boot-sound'
  import { isVoiceEnabled, setVoiceEnabled } from '$lib/speech/tts'

  /**
   * The homepage's settings entry point: a cog in the header, always reachable
   * (chat, welcome wizard, and provider gate alike). Company settings, the
   * extension roadmap, API keys and provider live on their pages; restarting
   * onboarding clears the welcome stamp and reloads page data so the boot
   * sequence takes over the homepage again. Sound (boot sequence, default on)
   * and assistant voice toggle here; sign out ends the session.
   */

  let menuOpen = $state(false)
  let restarting = $state(false)
  let signingOut = $state(false)
  let soundOn = $state(true)
  let voiceOn = $state(true)
  let error = $state<string | null>(null)

  function toggleSound(): void {
    soundOn = !soundOn
    setSoundEnabled(soundOn)
  }

  function toggleVoice(): void {
    voiceOn = !voiceOn
    setVoiceEnabled(voiceOn)
  }

  function syncSound(): void {
    soundOn = isSoundEnabled()
    voiceOn = isVoiceEnabled()
  }

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

  async function signOut(): Promise<void> {
    if (signingOut) return
    signingOut = true
    error = null
    try {
      const res = await fetch('/api/session/sign-out', { method: 'POST', credentials: 'include' })
      if (!res.ok) {
        throw new Error(`Sign out failed (HTTP ${res.status}).`)
      }
      await goto(resolve('/login'))
      menuOpen = false
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      signingOut = false
    }
  }
</script>

<Popover.Root bind:open={menuOpen} onOpenChange={(open) => open && syncSound()}>
  <Popover.Trigger
    class="text-muted-foreground hover:text-foreground flex size-8 cursor-pointer items-center justify-center rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
    aria-label="Settings menu"
    data-testid="home-settings-trigger"
  >
    <Settings class="pointer-events-none size-5 shrink-0" aria-hidden="true" strokeWidth={1.75} />
  </Popover.Trigger>
  <Popover.Content
    align="end"
    side="bottom"
    sideOffset={6}
    class="w-56 gap-1 overflow-hidden pt-2 pb-2"
  >
    <a
      href={resolve('/settings')}
      class="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
    >
      <Settings class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
      Settings
    </a>
    <div class="bg-border my-1 h-px"></div>
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-white/25 disabled:opacity-50 dark:hover:bg-white/10"
      onclick={toggleSound}
      data-testid="sound-toggle"
    >
      {#if soundOn}
        <Volume2 class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
        Sound on
      {:else}
        <VolumeX class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
        Sound off
      {/if}
    </button>
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-white/25 disabled:opacity-50 dark:hover:bg-white/10"
      onclick={toggleVoice}
      data-testid="voice-toggle"
    >
      <Speech class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
      {voiceOn ? 'Voice on' : 'Voice off'}
    </button>
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
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-white/25 disabled:opacity-50 dark:hover:bg-white/10"
      disabled={signingOut}
      onclick={() => void signOut()}
      data-testid="sign-out"
    >
      {#if signingOut}
        <LoaderCircle class="size-4 shrink-0 animate-spin" strokeWidth={1.75} />
      {:else}
        <LogOut class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
      {/if}
      Sign out
    </button>
    {#if error}
      <p class="text-destructive mt-1 px-2 text-xs leading-relaxed" role="alert">
        {error}
      </p>
    {/if}
  </Popover.Content>
</Popover.Root>
