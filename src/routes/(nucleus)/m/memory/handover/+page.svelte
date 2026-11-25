<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { shownErrorOf } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'
  import { docTitle } from '$lib/shell/title'
  import Handover from './handover.svelte'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  const formError = $derived.by(() => {
    const shown = shownErrorOf(form)
    return shown && form && 'formId' in form ? { formId: String(form.formId), ...shown } : null
  })
</script>

<svelte:head><title>{docTitle(m.memory_tab_handover(), 'Memory')}</title></svelte:head>

<div class="w-full min-w-0 px-4 pt-4 pb-10 sm:px-8">
  <Handover handovers={data.handovers} members={data.members} userId={data.userId} {formError} />
</div>
