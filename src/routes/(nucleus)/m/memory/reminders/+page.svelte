<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { docTitle } from '$lib/shell/title'
  import Reminders from './reminders.svelte'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  const formMessage = $derived(
    form && 'message' in form && typeof form.message === 'string' ? { reminderId: String(form.reminderId), message: form.message } : null,
  )
</script>

<svelte:head><title>{docTitle('Reminders', 'Memory')}</title></svelte:head>

<div class="w-full max-w-3xl px-4 pt-4 pb-10 sm:px-8">
  <Reminders reminders={data.reminders} timeZone={data.timeZone} {formMessage} />
</div>
