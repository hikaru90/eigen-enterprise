<script lang="ts">
  import AudioLines from '@lucide/svelte/icons/audio-lines'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Download from '@lucide/svelte/icons/download'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import LogOut from '@lucide/svelte/icons/log-out'
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal'
  import Speech from '@lucide/svelte/icons/speech'
  import UserCog from '@lucide/svelte/icons/user-cog'
  import Volume2 from '@lucide/svelte/icons/volume-2'
  import VolumeX from '@lucide/svelte/icons/volume-x'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { requestSignOut } from '$lib/auth/sign-out'
  import AudioDevicesSettings from '$lib/components/audio-devices-settings.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import * as Popover from '$lib/components/ui/popover'
  import { isStandalone } from '$lib/pwa/install'
  import InstallAppDialog from '$lib/pwa/install-app-dialog.svelte'
  import { isSoundEnabled, setSoundEnabled } from '$lib/sound/boot-sound'
  import { isVoiceEnabled, setVoiceEnabled } from '$lib/speech/tts'
  import VoicePlaybackControls from '$lib/speech/voice-playback-controls.svelte'
  import ThemeSwitch from '$lib/theme/theme-switch.svelte'

  /**
   * The personal menu next to the signed-in name: this person's own quick
   * preferences, in one place. Settings itself lives only in the main nav (one
   * entry, 81319f0e); this menu holds what is per person / per device: theme
   * (Light · Dark · System), sound (boot sequence), assistant voice on/off,
   * audio devices (microphone + speaker, shared with calls), the reading voice's
   * speed and volume, "Install app" (hidden inside the installed app), and
   * sign out.
   */

  let menuOpen = $state(false)
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
    aria-label="Your preferences"
    data-testid="home-settings-trigger"
  >
    <UserCog class="pointer-events-none size-5 shrink-0" aria-hidden="true" strokeWidth={1.75} />
  </Popover.Trigger>
  <Popover.Content
    align="end"
    side="bottom"
    sideOffset={6}
    class="w-56 gap-1 overflow-hidden pt-2 pb-2"
  >
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
        attempted="Signing out from your preferences menu"
      />
    {/if}
  </Popover.Content>
</Popover.Root>

<InstallAppDialog bind:this={installDialog} />
