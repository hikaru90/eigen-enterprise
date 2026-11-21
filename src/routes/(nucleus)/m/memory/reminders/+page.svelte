<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { shownErrorOf } from '$lib/errors/agent-report'
  import { docTitle } from '$lib/shell/title'
  import Reminders from './reminders.svelte'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  const formError = $derived.by(() => {
    const shown = shownErrorOf(form)
    return shown && form && 'reminderId' in form
      ? { reminderId: String(form.reminderId), ...shown }
      : null
  })
</script>

<svelte:head><title>{docTitle('Reminders', 'Memory')}</title></svelte:head>

<div class="w-full max-w-3xl px-4 pt-4 pb-10 sm:px-8">
  <Reminders reminders={data.reminders} timeZone={data.timeZone} {formError} />
</div>
