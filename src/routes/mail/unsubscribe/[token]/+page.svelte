<script lang="ts">
  import type { PageProps } from './$types'
  import MailPublicFrame from '$lib/components/email/mail-public-frame.svelte'
  import { Button } from '$lib/components/ui/button'

  let { data, form }: PageProps = $props()
  const done = $derived(data.unsubscribed || Boolean(form?.done))
</script>

<svelte:head><title>Unsubscribe</title><meta name="robots" content="noindex" /></svelte:head>

<MailPublicFrame title={done ? 'You are unsubscribed' : 'Unsubscribe'}>
  {#if done}
    <p data-testid="unsubscribed">{data.email} gets no more mail from “{data.list}”.</p>
  {:else}
    <p>Stop mail from “{data.list}” to {data.email}?</p>
    <form method="POST" class="mt-6">
      <Button type="submit" data-testid="unsubscribe-confirm">Unsubscribe</Button>
    </form>
  {/if}
</MailPublicFrame>
