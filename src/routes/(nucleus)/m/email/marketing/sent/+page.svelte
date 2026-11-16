<script lang="ts">
  import type { PageProps } from './$types'
  import MailOutbox from '$lib/components/email/mail-outbox.svelte'
  import { docTitle } from '$lib/shell/title'

  /** Email › Marketing mail › Sent (owner and admins): what the flows have waiting for, and sent to, the lists. */
  let { data }: PageProps = $props()
</script>

<svelte:head><title>{docTitle('Sent marketing mail', 'Email')}</title></svelte:head>

<MailOutbox
  connected={data.connected}
  pending={data.pending}
  sent={data.sent}
  pendingEmpty="No flow mail waiting to go out."
  sentEmpty="No marketing mail sent yet. Flows send it when someone joins a list."
/>
