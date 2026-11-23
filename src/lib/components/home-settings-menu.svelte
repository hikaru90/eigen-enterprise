<script lang="ts">
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import AudioLines from '@lucide/svelte/icons/audio-lines'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Download from '@lucide/svelte/icons/download'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import LogOut from '@lucide/svelte/icons/log-out'
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw'
  import Settings from '@lucide/svelte/icons/settings'
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal'
  import Speech from '@lucide/svelte/icons/speech'
  import Volume2 from '@lucide/svelte/icons/volume-2'
  import VolumeX from '@lucide/svelte/icons/volume-x'
  import { goto, invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { requestSignOut } from '$lib/auth/sign-out'
  import AudioDevicesSettings from '$lib/components/audio-devices-settings.svelte'
  import * as Popover from '$lib/components/ui/popover'
  import { isStandalone } from '$lib/pwa/install'
  import InstallAppDialog from '$lib/pwa/install-app-dialog.svelte'
  import { isSoundEnabled, setSoundEnabled } from '$lib/sound/boot-sound'
  import { isVoiceEnabled, setVoiceEnabled } from '$lib/speech/tts'
  import VoicePlaybackControls from '$lib/speech/voice-playback-controls.svelte'
  import ThemeSwitch from '$lib/theme/theme-switch.svelte'

  /**
   * The homepage's settings entry point: a cog in the header, always reachable
   * (chat, welcome wizard, and provider gate alike). Company settings, the
   * extension roadmap, API keys and provider live on their pages; restarting
   * onboarding clears the welcome stamp and reloads page data so the boot
   * sequence takes over the homepage again. Theme (Light · Dark · System, this
   * device) applies the moment it is picked. Sound (boot sequence, default on)
   * and assistant voice toggle here; "Audio devices" opens the microphone + speaker choice
   * (shared with calls) used by dictation, voice messages and the assistant's voice; "Voice speed
   * and volume" opens the reading voice's speed and volume for this browser; sign out
   * ends the session. "Install app"
   * (hidden inside the installed app) installs eigenEnterprise on this device.
   */

  let menuOpen = $state(false)
  let restarting = $state(false)
  let signingOut = $state(false)
  /** Why signing out was held back (it would end the only way back in); null when it wasn't. */
  let lockout = $state<string | null>(null)
  let soundOn = $state(true)
  let voiceOn = $state(true)
  let devicesOpen = $state(false)
  let playbackOpen = $state(false)
  let error = $state<string | null>(null)
  let runningAsApp = $state(false)
  let installDialog = $state<ReturnType<typeof InstallAppDialog> | null>(null)

  function openInstall(): void {
    menuOpen = false
    installDialog?.show()
  }

  function toggleSound(): void {
    soundOn = !soundOn
    setSoundEnabled(soundOn)
  }

  function toggleVoice(): void {
    voiceOn = !voiceOn
    setVoiceEnabled(voiceOn)
  }

  function syncMenu(): void {
    soundOn = isSoundEnabled()
    voiceOn = isVoiceEnabled()
    devicesOpen = false
    playbackOpen = false
    runningAsApp = isStandalone()
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

  async function signOut(confirmLockout = false): Promise<void> {
    if (signingOut) return
    signingOut = true
    error = null
    try {
      const r = await requestSignOut(confirmLockout)
      if (!r.ok) {
        lockout = r.lockout
        return
      }
      lockout = null
      await goto(resolve('/login'))
      menuOpen = false
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      signingOut = false
    }
  }
</script>

<Popover.Root bind:open={menuOpen} onOpenChange={(open) => open && syncMenu()}>
  <Popover.Trigger
    class="text-muted-foreground hover:text-foreground flex size-8 cursor-pointer items-center justify-center rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-1 -ring"
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
    {#if !runningAsApp}
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-white/25 disabled:opacity-50 dark:hover:bg-white/10"
        onclick={openInstall}
        data-testid="install-app"
      >
        <Download class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
        Install app
      </button>
    {/if}
    <div class="bg-border my-1 h-px"></div>
    <div class="px-2 py-1">
      <ThemeSwitch testid="menu-theme-switch" class="w-full" />
    </div>
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
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-white/25 disabled:opacity-50 dark:hover:bg-white/10"
      aria-expanded={devicesOpen}
      onclick={() => (devicesOpen = !devicesOpen)}
      data-testid="audio-devices-toggle"
    >
      <AudioLines class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
      <span class="flex-1">Audio devices</span>
      <ChevronDown
        class="size-3.5 shrink-0 opacity-60 transition-transform {devicesOpen ? 'rotate-180' : ''}"
        strokeWidth={1.75}
      />
    </button>
    {#if devicesOpen}
      <AudioDevicesSettings />
    {/if}
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-white/25 disabled:opacity-50 dark:hover:bg-white/10"
      aria-expanded={playbackOpen}
      onclick={() => (playbackOpen = !playbackOpen)}
      data-testid="voice-playback-toggle"
    >
      <SlidersHorizontal class="size-4 shrink-0 opacity-80" strokeWidth={1.75} />
      <span class="flex-1">Voice speed and volume</span>
      <ChevronDown
        class="size-3.5 shrink-0 opacity-60 transition-transform {playbackOpen ? 'rotate-180' : ''}"
        strokeWidth={1.75}
      />
    </button>
    {#if playbackOpen}
      <VoicePlaybackControls />
    {/if}
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
    {#if lockout}
      <div
        class="mt-1 space-y-1.5 px-2 text-xs leading-relaxed"
        role="alert"
        data-testid="sign-out-lockout"
      >
        <p class="text-destructive">{lockout}</p>
        <p class="flex gap-3">
          <a
            href={resolve('/settings/passkeys')}
            class="underline underline-offset-4"
            onclick={() => (menuOpen = false)}>Add a passkey</a
          >
          <button
            type="button"
            class="underline underline-offset-4"
            onclick={() => void signOut(true)}
            data-testid="sign-out-anyway">Sign out anyway</button
          >
        </p>
      </div>
    {/if}
    {#if error}
      <ErrorNotice
        class="mt-1 px-2 text-xs leading-relaxed"
        {error}
        attempted="Signing out or restarting the app from the settings menu"
      />
    {/if}
  </Popover.Content>
</Popover.Root>

<InstallAppDialog bind:this={installDialog} />
