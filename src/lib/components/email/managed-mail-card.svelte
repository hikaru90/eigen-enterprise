<script lang="ts">
  /**
   * eigenEnterprise Mail's account card (plan/managed-mail.md, D8): no keys,
   * no sandbox, no IAM policy — the control plane runs the SES side.
   */
  type Props = {
    region: string
    /** The default sender, or '' before the first sender on a verified domain. */
    sender: string
    paused: boolean
    /** GetTenant failed: Amazon's reason in plain words. */
    error?: string | null
  }
  let { region, sender, paused, error = null }: Props = $props()
</script>

<dl
  class="mt-3 divide-y divide-border rounded-lg border border-border text-sm"
  data-testid="email-managed-account"
>
  <div class="px-4 py-2.5">
    <dt class="sr-only">Provider</dt>
    <dd class="font-medium">eigenEnterprise Mail</dd>
    <p class="mt-1 text-xs text-muted-foreground">
      Mail goes out and comes in through eigenEnterprise. Add your domain and publish its DNS
      records; there are no keys to manage.
    </p>
  </div>
  <div class="flex justify-between gap-4 px-4 py-2.5">
    <dt class="text-muted-foreground">Region</dt>
    <dd>{region}</dd>
  </div>
  <div class="flex justify-between gap-4 px-4 py-2.5">
    <dt class="text-muted-foreground">Default sender</dt>
    <dd class="min-w-0 truncate">{sender || 'None yet'}</dd>
  </div>
  <div class="px-4 py-2.5">
    <div class="flex justify-between gap-4">
      <dt class="text-muted-foreground">Sending</dt>
      <dd>{paused ? 'Paused' : 'On'}</dd>
    </div>
    {#if paused}
      <p class="mt-1.5 text-xs text-destructive" role="alert" data-testid="email-managed-paused">
        Sending is paused because too many mails bounced or were marked as spam. Contact support.
      </p>
    {/if}
    {#if error}<p class="mt-1.5 text-xs text-destructive">{error}</p>{/if}
  </div>
</dl>
