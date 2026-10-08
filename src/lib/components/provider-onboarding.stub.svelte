<script lang="ts">
  /**
   * Test stub for provider-onboarding.svelte (mocked in welcome-wizard.svelte.spec.ts).
   * Models only the contract the boot sequence cares about: it renders, and it
   * reports success through the explicit `onconnected` callback.
   */
  let { onconnected }: { onconnected?: () => void } = $props()
</script>

<div data-testid="provider-onboarding">the mind goes here</div>
<button type="button" data-testid="simulate-connected" onclick={() => onconnected?.()}>
  Simulate connected
</button>
