<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import type { AssistantController } from '$lib/components/assistant/assistant-controller.svelte'
  import { provideAssistant } from '$lib/components/assistant/context'
  import Dashboard from './dashboard.svelte'

  /** Test-only: the dashboard as the shell provides it — with the assistant, or with it switched off (null). */
  let {
    assistant,
    ...props
  }: { assistant: AssistantController | null } & ComponentProps<typeof Dashboard> = $props()
  // svelte-ignore state_referenced_locally
  provideAssistant(assistant)
</script>

<Dashboard {...props} />
