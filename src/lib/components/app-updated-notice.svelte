<script lang="ts">
  import { onMount } from 'svelte'
  import { APP_UPDATED_SENTENCE } from '$lib/app-update/detect'
  import { appUpdate, reloadPage } from '$lib/app-update/state.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'

  /**
   * "eigenEnterprise was updated — reload to open this." with a Reload button:
   * what a person sees where something failed to load because a new release
   * replaced the build their tab started on (src/lib/app-update/detect.ts).
   * Reloading the page is a browser affordance, not a company action, so it is
   * not a registry tool.
   */
  let {
    attempted,
    reload = reloadPage,
    class: className,
    testid,
  }: {
    /** What the page was doing when the load failed (for the agent brief). */
    attempted?: string
    reload?: () => void
    class?: string
    testid?: string
  } = $props()

  onMount(() => {
    appUpdate.inline += 1
    return () => {
      appUpdate.inline -= 1
    }
  })
</script>

<ErrorNotice class={className} {testid} error={APP_UPDATED_SENTENCE} {attempted}>
  <Button size="sm" variant="outline" onclick={() => reload()}>Reload</Button>
</ErrorNotice>
