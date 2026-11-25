<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { shownErrorOf } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'
  import { docTitle } from '$lib/shell/title'
  import Questions from './questions.svelte'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  const formError = $derived.by(() => {
    const shown = shownErrorOf(form)
    return shown && form && 'questionId' in form
      ? { questionId: String(form.questionId), ...shown }
      : null
  })
</script>

<svelte:head><title>{docTitle(m.memory_tab_questions(), 'Memory')}</title></svelte:head>

<div class="w-full min-w-0 px-4 pt-4 pb-10 sm:px-8">
  <Questions
    questions={data.questions}
    tags={data.tags}
    audience={data.audience}
    filter={data.filter}
    {formError}
  />
</div>
