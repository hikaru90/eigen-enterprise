<script lang="ts">
  import type { PageProps } from './$types'
  import MailOutbox from '$lib/components/email/mail-outbox.svelte'
  import { docTitle } from '$lib/shell/title'

  /** Email › Transactional mail (owner and admins): the automatic mail waiting to go out and what went out. */
  let { data }: PageProps = $props()
</script>

<svelte:head><title>{docTitle('Transactional mail', 'Email')}</title></svelte:head>

<MailOutbox
  connected={data.connected}
  pending={data.pending}
  sent={data.sent}
  pendingEmpty="Nothing waiting to go out."
  sentEmpty="No transactional mail sent yet."
/>
