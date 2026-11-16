<script lang="ts">
  import type { PageProps } from './$types'
  import { deserialize } from '$app/forms'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'
  import PipelineBoard from '../../../../../../../modules/contacts/ui/pipeline-board.svelte'

  /** /m/email/people/pipeline: the contact pipeline, worked the GTD way. */
  let { data, form }: PageProps = $props()

  const logError = $derived(
    form && 'error' in form && typeof form.error === 'string' && form.action === 'log' && form.id ? { id: form.id, message: form.error } : null,
  )

  /** Post one inline change to ?/update; the page data refreshes on success. */
  async function save(id: string, patch: Record<string, string>): Promise<string | null> {
    const body = new FormData()
    body.set('id', id)
    for (const [k, v] of Object.entries(patch)) body.set(k, v)
    const res = await fetch('?/update', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } })
    const result = deserialize(await res.text())
    if (result.type === 'failure') {
      const err = (result.data as { error?: unknown } | undefined)?.error
      return typeof err === 'string' ? err : `Couldn’t save that (HTTP ${result.status}).`
    }
    if (result.type === 'error') return result.error instanceof Error ? result.error.message : `Couldn’t save that (HTTP ${result.status ?? res.status}).`
    await invalidateAll()
    return null
  }
</script>

<svelte:head><title>{docTitle('Pipeline', 'Email')}</title></svelte:head>

<SectionHeader
  title="Pipeline"
  description="Everyone you’re in touch with, in the list you put them in: our move, waiting for a reply, keep in the loop, not contacted yet. Change who holds a contact, how, the status and the next step right here; drag a row or pick its list to move it."
  testid="pipeline-header"
>
  {#snippet actions()}
    <Button variant="outline" href={resolve('/m/email/people')}>All contacts</Button>
    <Button href={resolve('/m/email/people/new')}>Add a contact</Button>
  {/snippet}
</SectionHeader>

<div class="mt-4">
  <PipelineBoard pipeline={data.pipeline} onsave={save} {logError} />
</div>
