<script lang="ts">
  import type { PageProps } from './$types'
  import MailPublicFrame from '$lib/components/email/mail-public-frame.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  let { data, form }: PageProps = $props()
</script>

<svelte:head><title>{data.list.name}</title></svelte:head>

<MailPublicFrame title={data.list.name}>
  {#if form && 'done' in form && form.done}
    <p data-testid="subscribe-done">
      {form.pending ? 'Almost there: we sent you an email — click the link in it to confirm.' : 'Thanks, you are subscribed.'}
    </p>
  {:else}
    {#if data.list.description}<p class="text-muted-foreground">{data.list.description}</p>{/if}
    <form method="POST" class="mt-6 grid gap-4">
      <div class="grid gap-1.5">
        <Label for="sub-email">Email</Label>
        <Input id="sub-email" name="email" type="email" required autocomplete="email" />
      </div>
      <div class="grid gap-1.5">
        <Label for="sub-name">First name (optional)</Label>
        <Input id="sub-name" name="firstName" autocomplete="given-name" />
      </div>
      {#if form && 'error' in form}<p class="text-destructive" role="alert">{form.error}</p>{/if}
      <Button type="submit">Subscribe</Button>
      <p class="text-xs text-muted-foreground">You can unsubscribe with one click from every mail.</p>
    </form>
  {/if}
</MailPublicFrame>
