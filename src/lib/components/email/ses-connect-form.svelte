<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { untrack } from 'svelte'
  import { invalidateAll } from '$app/navigation'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  /**
   * Connect Amazon SES from the Email page. Posts to the same endpoint as the
   * welcome wizard's email step (POST /api/onboarding/mail): Amazon gets a real
   * test email to the owner first, nothing is saved unless it went through.
   */
  let {
    initialRegion = 'eu-central-1',
    initialSender = '',
    submitLabel = 'Connect and send me a test email',
  }: { initialRegion?: string; initialSender?: string; submitLabel?: string } = $props()

  const SES_REGIONS: Array<{ id: string; label: string }> = [
    { id: 'eu-central-1', label: 'Europe — Frankfurt (eu-central-1)' },
    { id: 'eu-west-1', label: 'Europe — Ireland (eu-west-1)' },
    { id: 'eu-west-2', label: 'Europe — London (eu-west-2)' },
    { id: 'eu-west-3', label: 'Europe — Paris (eu-west-3)' },
    { id: 'eu-north-1', label: 'Europe — Stockholm (eu-north-1)' },
    { id: 'us-east-1', label: 'US East — N. Virginia (us-east-1)' },
    { id: 'us-east-2', label: 'US East — Ohio (us-east-2)' },
    { id: 'us-west-2', label: 'US West — Oregon (us-west-2)' },
    { id: 'ca-central-1', label: 'Canada (ca-central-1)' },
    { id: 'ap-south-1', label: 'Asia Pacific — Mumbai (ap-south-1)' },
    { id: 'ap-southeast-1', label: 'Asia Pacific — Singapore (ap-southeast-1)' },
    { id: 'ap-southeast-2', label: 'Asia Pacific — Sydney (ap-southeast-2)' },
    { id: 'ap-northeast-1', label: 'Asia Pacific — Tokyo (ap-northeast-1)' },
    { id: 'sa-east-1', label: 'South America — São Paulo (sa-east-1)' },
  ]

  // Seeded once from the props; the owner edits from there.
  let region = $state(untrack(() => initialRegion))
  let accessKeyId = $state('')
  let secretAccessKey = $state('')
  let emailFrom = $state(untrack(() => initialSender))
  let saving = $state(false)
  let error = $state<string | null>(null)
  let verifyAddress = $state<string | null>(null)
  let sentTo = $state<string | null>(null)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (saving) return
    saving = true
    error = null
    try {
      const res = await fetch('/api/onboarding/mail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, accessKeyId: accessKeyId.trim(), secretAccessKey, emailFrom: emailFrom.trim() }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string; needs?: string; emailFrom?: string; testSentTo?: string } | null
      if (res.status === 409 && body?.needs === 'verify_sender' && body.emailFrom) {
        verifyAddress = body.emailFrom
        return
      }
      if (!res.ok) throw new Error(body?.error ?? `Connecting Amazon SES failed (HTTP ${res.status}).`)
      verifyAddress = null
      sentTo = body?.testSentTo ?? null
      secretAccessKey = ''
      await invalidateAll()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      saving = false
    }
  }
</script>

<div class="max-w-2xl" data-testid="ses-connect">
  {#if sentTo}
    <p class="text-sm" role="status" data-testid="ses-connected">
      Connected. A test email went to {sentTo}.
    </p>
  {:else}
    <details class="rounded-md border border-border px-4 py-3 text-sm">
      <summary class="cursor-pointer font-medium">Where do I get these? (about 5 minutes)</summary>
      <ol class="mt-3 list-decimal space-y-1.5 pl-5 text-muted-foreground">
        <li>
          Sign in to Amazon Web Services and open the
          <a class="text-foreground underline underline-offset-4" href="https://console.aws.amazon.com/ses/" target="_blank" rel="noopener noreferrer"
            >Amazon SES console</a
          >. Note the region shown top right.
        </li>
        <li>
          Open the
          <a
            class="text-foreground underline underline-offset-4"
            href="https://console.aws.amazon.com/iam/home#/users/create"
            target="_blank"
            rel="noopener noreferrer">AWS user page</a
          >, create a user named “email-sender”, choose “Attach policies directly” and tick
          <strong>AmazonSESFullAccess</strong> and <strong>AmazonSNSFullAccess</strong> (SNS tells ee when
          mail is delivered, bounces or is opened).
        </li>
        <li>Open the user → “Security credentials” → “Create access key” → “Application running outside AWS”.</li>
        <li>Copy both values below. The send-from address must be one Amazon can verify — it emails you a link the first time.</li>
      </ol>
    </details>

    <form class="mt-4 grid gap-4 sm:grid-cols-2" onsubmit={submit}>
      <div class="grid gap-1.5">
        <Label for="ses-region">Region</Label>
        <select
          id="ses-region"
          bind:value={region}
          disabled={saving}
          class="h-9 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {#each SES_REGIONS as r (r.id)}<option value={r.id}>{r.label}</option>{/each}
        </select>
      </div>
      <div class="grid gap-1.5">
        <Label for="ses-from">Send-from address</Label>
        <Input id="ses-from" type="email" required placeholder="hello@yourcompany.com" bind:value={emailFrom} disabled={saving} />
      </div>
      <div class="grid gap-1.5">
        <Label for="ses-key-id">Access key ID</Label>
        <Input id="ses-key-id" required autocomplete="off" bind:value={accessKeyId} disabled={saving} />
      </div>
      <div class="grid gap-1.5">
        <Label for="ses-secret">Secret access key</Label>
        <Input id="ses-secret" type="password" required autocomplete="off" bind:value={secretAccessKey} disabled={saving} />
      </div>
      {#if verifyAddress}
        <p class="text-sm sm:col-span-2" role="status" data-testid="ses-verify-sender">
          Amazon sent a verification email to <strong>{verifyAddress}</strong>. Click the link in it, then press Try again.
        </p>
      {/if}
      {#if error}<p class="text-sm text-destructive sm:col-span-2" role="alert">{error}</p>{/if}
      <div class="sm:col-span-2">
        <Button type="submit" disabled={saving} data-testid="ses-connect-submit">
          {#if saving}<LoaderCircle class="size-4 animate-spin" />{/if}
          {verifyAddress ? 'Try again' : submitLabel}
        </Button>
      </div>
    </form>
  {/if}
</div>
