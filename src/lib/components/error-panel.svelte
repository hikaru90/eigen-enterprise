<script lang="ts">
  import { resolve } from '$app/paths'
  import Wordmark from '$lib/components/page/wordmark.svelte'
  import { Button } from '$lib/components/ui/button'
  import { pluginOffMessage, type PluginOff } from '$lib/plugins/routes'
  import { docTitle } from '$lib/shell/title'

  /**
   * The one error page body. Signed in: the way back is the dashboard. Signed
   * out: the way in is Sign in. Never an old-app link. A 403 is not an error
   * the person caused or can fix: it says plainly that the page is not
   * theirs and who can help (Contribute `2bda4814`) — no status code, no
   * "Forbidden". A switched-off plugin (the plugin gate) says just that, and
   * who can switch it on: the owner/admins get the way to Settings → Plugins.
   */
  let {
    status,
    message,
    signedIn,
    pluginOff = null,
  }: {
    status: number
    message: string | null | undefined
    signedIn: boolean
    pluginOff?: PluginOff | null
  } = $props()

  const isNotFound = $derived(status === 404 && !pluginOff)
  const isForbidden = $derived(status === 403)
  const heading = $derived(
    pluginOff
      ? pluginOffMessage(pluginOff.name)
      : isNotFound
        ? 'Page not found'
        : isForbidden
          ? "You don't have access to this page"
          : 'Something went wrong',
  )
</script>

<svelte:head>
  <title>{docTitle(heading)}</title>
</svelte:head>

<div
  class="mx-auto flex w-full max-w-md flex-col items-center px-5 pt-16 pb-16 text-center"
  data-testid="error-page"
>
  {#if !signedIn}
    <div class="mb-8"><Wordmark /></div>
  {/if}
  {#if !isForbidden && !pluginOff}
    <p class="text-xs text-muted-foreground tabular-nums">Error {status}</p>
  {/if}
  <h1 class="mt-2 text-xl font-semibold tracking-tight">{heading}</h1>
  {#if pluginOff}
    <p class="mt-2 text-sm text-foreground/60" data-testid="plugin-off">
      {#if pluginOff.canManage}
        You can switch it on again in Settings → Plugins; everything in it is kept.
      {:else}
        Ask an admin to switch it on.
      {/if}
    </p>
    {#if pluginOff.canManage}
      <Button href={resolve('/settings/modules')} class="mt-8" size="lg" data-testid="plugin-off-switch"
        >Open Settings → Plugins</Button
      >
    {/if}
  {:else if isNotFound}
    <p class="mt-2 text-sm text-foreground/60">This address does not exist (any more).</p>
  {:else if isForbidden}
    <p class="mt-2 text-sm text-foreground/60" data-testid="error-no-access">
      Ask an owner or an admin if you need it.
    </p>
  {:else if message}
    <p class="mt-2 text-xs text-foreground/60">{message}</p>
  {/if}
  {#if signedIn}
    <Button
      href={resolve('/')}
      class={pluginOff?.canManage ? 'mt-3' : 'mt-8'}
      size="lg"
      variant={pluginOff?.canManage ? 'outline' : 'default'}
      data-testid="error-back">Back to the dashboard</Button
    >
  {:else}
    <Button href={resolve('/login')} class="mt-8" size="lg" data-testid="error-back">Sign in</Button
    >
  {/if}
</div>
