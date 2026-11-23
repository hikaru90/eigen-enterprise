<script lang="ts">
  import type { AssistantController } from '$lib/components/assistant/assistant-controller.svelte'
  import { provideAssistant } from '$lib/components/assistant/context'
  import TellTheBrain from './tell-the-brain.svelte'

  /** Test-only: the line as the shell provides it — with the assistant, or switched off (null). */
  let { assistant }: { assistant: AssistantController | null } = $props()
  // svelte-ignore state_referenced_locally
  provideAssistant(assistant)
</script>

<TellTheBrain />
