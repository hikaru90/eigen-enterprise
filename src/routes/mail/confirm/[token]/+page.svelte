<script lang="ts">
  import type { PageProps } from './$types'
  import MailPublicFrame from '$lib/components/email/mail-public-frame.svelte'
  import { Button } from '$lib/components/ui/button'

  let { data, form }: PageProps = $props()
  const status = $derived(form?.status ?? data.status)
</script>

<svelte:head><title>Confirm your subscription</title><meta name="robots" content="noindex" /></svelte:head>

<MailPublicFrame title={status === 'subscribed' ? 'You are subscribed' : status === 'unsubscribed' ? 'Unsubscribed' : 'Confirm your subscription'}>
  {#if status === 'subscribed'}
    <p data-testid="confirmed">Thanks — {data.email} now gets mail from “{data.list}”.</p>
  {:else if status === 'unsubscribed'}
    <p>{data.email} unsubscribed from “{data.list}” and gets no mail from it.</p>
  {:else}
    <p>Send mail from “{data.list}” to {data.email}?</p>
    <form method="POST" class="mt-6">
      <Button type="submit" data-testid="confirm-subscription">Yes, subscribe me</Button>
    </form>
  {/if}
</MailPublicFrame>
