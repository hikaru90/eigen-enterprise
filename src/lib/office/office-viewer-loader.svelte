<script lang="ts">
  import type { OfficeViewerModule, OfficeViewerProps } from './viewers'
  import { AppUpdatedError, loadChunk, type CheckUpdated } from '$lib/app-update/detect'
  import { checkUpdated, reloadPage } from '$lib/app-update/state.svelte'
  import AppUpdatedNotice from '$lib/components/app-updated-notice.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'

  /**
   * Loads a format's viewer chunk (./viewers.ts) and renders it. A load that
   * fails because a new release replaced this tab's build says "reload"; any
   * other failure shows its real error. Loaded once per mount, never retried.
   */
  let {
    load,
    viewerProps,
    check = checkUpdated,
    reload = reloadPage,
  }: {
    load: () => Promise<OfficeViewerModule>
    viewerProps: OfficeViewerProps
    check?: CheckUpdated
    reload?: () => void
  } = $props()

  // Started once, at mount: the page keys this component on the file's content.
  // svelte-ignore state_referenced_locally
  const loading = loadChunk(load, check)
</script>

{#await loading}
  <div
    class="flex flex-1 items-center justify-center text-sm text-muted-foreground"
    data-testid="drive-office-loading"
  >
    Opening {viewerProps.name}…
  </div>
{:then viewer}
  <viewer.default {...viewerProps} />
{:catch err}
  {#if err instanceof AppUpdatedError}
    <AppUpdatedNotice
      class="m-6"
      testid="drive-office-error"
      {reload}
      attempted={`Loading the office viewer for ${viewerProps.name} in the browser`}
    />
  {:else}
    <ErrorNotice
      class="m-6"
      testid="drive-office-error"
      error={`The viewer could not be loaded: ${err instanceof Error ? err.message : String(err)}`}
      attempted={`Loading the office viewer for ${viewerProps.name} in the browser`}
    />
  {/if}
{/await}
