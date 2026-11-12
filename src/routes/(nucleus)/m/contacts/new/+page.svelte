<script lang="ts">
  import type { PageProps } from './$types'
  import { resolve } from '$app/paths'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { docTitle } from '$lib/shell/title'
  import ContactForm from '../../../../../../modules/contacts/ui/contact-form.svelte'

  /** /m/contacts/new: add a person you know. */
  let { data, form }: PageProps = $props()
</script>

<svelte:head><title>{docTitle('Add a contact', 'Contacts')}</title></svelte:head>

<a class="text-sm text-muted-foreground hover:text-foreground" href={resolve('/m/contacts')}>← All contacts</a>
<div class="mt-3">
  <PageHeader
    title="Add a contact"
    description="Only the name is needed. It stays private to you (and the company owner and admins) unless you share it."
  />
</div>
<div class="mt-6">
  <ContactForm
    suggestedTags={data.tags}
    submitLabel="Add contact"
    offerShare
    error={form && 'error' in form ? form.error : null}
  />
</div>
