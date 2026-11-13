<script lang="ts">
  import type { PageProps } from './$types'
  import { resolve } from '$app/paths'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'
  import ImportFile from '../../../../../../../modules/contacts/ui/import-file.svelte'
  import ImportPreview from '../../../../../../../modules/contacts/ui/import-preview.svelte'

  /**
   * /m/email/people/import: read a vCard or CSV file (step 1), check who is
   * new and who you already have (step 2, nothing saved), import what you
   * confirm.
   */
  let { form }: PageProps = $props()
  const errorFor = (action: string) => (form && 'error' in form && form.action === action ? form.error : null)
  const preview = $derived(form && 'preview' in form ? form.preview : null)
  const done = $derived(
    form && 'imported' in form && form.imported !== undefined && form.skipped !== undefined
      ? { imported: form.imported, skipped: form.skipped }
      : null,
  )
</script>

<svelte:head><title>{docTitle('Import contacts', 'Contacts')}</title></svelte:head>

<a class="text-sm text-muted-foreground hover:text-foreground" href={resolve('/m/email/people')}>← All contacts</a>
<div class="mt-3">
  <SectionHeader
    title="Import contacts"
    description="From a vCard (.vcf) or a CSV table. You check who is new first; people you already have (same email) are never changed."
    testid="import-header"
  />
</div>

<div class="mt-5">
  {#if done}
    <div class="grid max-w-2xl gap-3" role="status" data-testid="import-done">
      <p class="text-sm">
        Imported {done.imported.length}
        {done.imported.length === 1 ? 'contact' : 'contacts'}.{#if done.skipped > 0}
          {done.skipped} already in your contacts {done.skipped === 1 ? 'was' : 'were'} skipped and left as {done.skipped === 1 ? 'it was' : 'they were'}.{/if}
      </p>
      <div class="flex flex-wrap gap-2">
        <Button href={resolve('/m/email/people')}>See your contacts</Button>
        <Button variant="outline" href={resolve('/m/email/people/import')}>Import another file</Button>
      </div>
    </div>
  {:else if preview}
    <ImportPreview {preview} error={errorFor('import')} />
  {:else}
    <ImportFile error={errorFor('preview')} />
  {/if}
</div>
