<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import Copy from '@lucide/svelte/icons/copy'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { onInstallChange, readInstallEnvironment, runNativeInstall } from './install'
  import { installGuide, type InstallGuide } from './install-prompt'

  /**
   * "Install app" (settings menu): the browser's own install dialog where the
   * browser offers one, otherwise the exact taps for this browser
   * (installGuide). A dismissed browser dialog falls back to the menu path, so
   * there is always a way forward on this screen.
   */

  let open = $state(false)
  let guide = $state<InstallGuide | null>(null)
  let installing = $state(false)
  let error = $state<string | null>(null)
  let copied = $state(false)

  function refresh(): void {
    try {
      guide = installGuide(readInstallEnvironment())
    } catch (err) {
      guide = null
      error = err instanceof Error ? err.message : String(err)
    }
  }

  /** Opens the dialog with a fresh read of this browser. */
  export function show(): void {
    error = null
    copied = false
    refresh()
    open = true
  }

  function onOpenChange(next: boolean): void {
    open = next
  }

  async function install(): Promise<void> {
    installing = true
    error = null
    try {
      const outcome = await runNativeInstall()
      // Accepted: appinstalled follows and refreshes the guide. Dismissed: the
      // dialog is spent, so show the menu path instead.
      if (outcome === 'dismissed') refresh()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      refresh()
    } finally {
      installing = false
    }
  }

  async function copyLink(): Promise<void> {
    error = null
    try {
      await navigator.clipboard.writeText(window.location.origin)
      copied = true
    } catch (err) {
      error = `Could not copy the link: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  onMount(() => {
    return onInstallChange(() => {
      if (open) refresh()
    })
  })
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content class="max-w-md" data-testid="install-app-dialog" data-kind={guide?.kind}>
    <Dialog.Header>
      <Dialog.Title>Install the app</Dialog.Title>
      <Dialog.Description>
        Your company on your home screen or dock: opens full-screen, launches instantly, and gets notifications.
      </Dialog.Description>
    </Dialog.Header>

    {#if guide?.kind === 'installed'}
      <p class="text-sm" data-testid="install-installed">You are using the installed app already.</p>
    {:else if guide?.kind === 'just-installed'}
      <p class="flex items-center gap-2 text-sm" data-testid="install-done">
        <Check class="size-4 text-primary" aria-hidden="true" />
        Installed. Open it from your home screen, dock or app list.
      </p>
    {:else if guide?.kind === 'insecure'}
      <p class="text-sm" data-testid="install-insecure">
        Browsers only install apps from a secure (https) address. Open this site over https to install it.
      </p>
    {:else if guide?.kind === 'native'}
      <Button disabled={installing} onclick={() => void install()} data-testid="install-native">
        {#if installing}<LoaderCircle class="size-4 animate-spin" aria-hidden="true" />{/if}
        Install
      </Button>
    {:else if guide?.kind === 'steps'}
      <ol class="list-decimal space-y-1.5 pl-5 text-sm" data-testid="install-steps">
        {#each guide.steps as step (step)}<li>{step}</li>{/each}
      </ol>
      {#if guide.note}<p class="text-xs text-muted-foreground">{guide.note}</p>{/if}
    {:else if guide?.kind === 'unsupported'}
      <p class="text-sm" data-testid="install-unsupported">{guide.message}</p>
      <Button variant="outline" size="sm" class="justify-self-start" onclick={() => void copyLink()} data-testid="install-copy-link">
        {#if copied}<Check class="size-4" aria-hidden="true" /> Link copied{:else}<Copy class="size-4" aria-hidden="true" /> Copy link{/if}
      </Button>
    {/if}

    {#if error}<p class="text-sm text-destructive" role="alert" data-testid="install-error">{error}</p>{/if}
  </Dialog.Content>
</Dialog.Root>
