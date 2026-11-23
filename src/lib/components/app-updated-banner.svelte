<script lang="ts">
  import { APP_UPDATED_SENTENCE } from '$lib/app-update/detect'
  import { appUpdate, reloadPage } from '$lib/app-update/state.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'

  /**
   * App-wide: something on the page failed to load after a new release
   * (`appUpdate.detected`, set by the root layout's stale-chunk watch). Shown
   * unless an inline update notice already says it where the load failed.
   */
  let { reload = reloadPage }: { reload?: () => void } = $props()
</script>

{#if appUpdate.detected && appUpdate.inline === 0}
  <div
    class="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-lg border bg-background p-4 shadow-lg"
    data-testid="app-updated-banner"
  >
    <ErrorNotice error={APP_UPDATED_SENTENCE} attempted="Loading part of eigenEnterprise in the browser">
      <Button size="sm" variant="outline" onclick={() => reload()}>Reload</Button>
    </ErrorNotice>
  </div>
{/if}
