<script lang="ts">
  import type { PageProps } from './$types'
  import { resolve } from '$app/paths'
  import CopyButton from '$lib/components/email/copy-button.svelte'
  import SendingKeys from '$lib/components/email/sending-keys.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: PageProps = $props()
  /** The key just created (shown once) fills the example; otherwise the env var. */
  let createdKey = $state<string | null>(null)
  const from = $derived(data.sender ?? 'hello@yourcompany.com')
  const curl = $derived(
    `curl -X POST ${data.endpoint} \\\n` +
      `  -H "Authorization: Bearer ${createdKey ?? '$EE_API_KEY'}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{\n` +
      `    "from": "${from}",\n` +
      `    "to": "someone@example.com",\n` +
      `    "subject": "Your order has shipped",\n` +
      `    "text": "Hi! Your order is on its way.",\n` +
      `    "idempotencyKey": "order-1001-shipped"\n` +
      `  }'`,
  )

  const FIELDS: [string, string, string][] = [
    ['to', 'required', 'One recipient address.'],
    ['subject', 'required*', 'The subject line.'],
    [
      'text',
      'required*',
      'The plain-text body. Without html, ee builds a simple html version from it.',
    ],
    ['html', 'optional', 'The html body.'],
    [
      'from',
      'optional',
      'One of your senders (Email › Senders). Leave it out to use the default sender.',
    ],
    ['replyTo', 'optional', 'Where replies go.'],
    [
      'scheduledAt',
      'optional',
      'Send later: an ISO time like 2026-12-01T09:00:00Z, within 30 days.',
    ],
    [
      'templateId',
      'optional',
      'Send a saved template (Email › Templates) instead of subject, text and html.',
    ],
    [
      'variables',
      'optional',
      'With a templateId: its {{ variables }} as text, like { "firstName": "Ada" }.',
    ],
    [
      'idempotencyKey',
      'optional',
      'Any unique text per mail. Retrying with the same key never sends twice (24 hours).',
    ],
  ]
  const ANSWERS: [string, string][] = [
    [
      '200',
      '{ "id", "status": "sent" | "scheduled" | "suppressed", "to" } — the id is the entry in Email › Logs.',
    ],
    ['400', 'Something in the body is wrong; "fields" says what.'],
    ['401 / 403', 'The key is missing, revoked, or may not send mail.'],
    [
      '404 / 422',
      'The templateId does not exist, or a variable is missing ("missing" lists them).',
    ],
    ['429', 'More than 60 mails a minute from one key; wait the Retry-After seconds.'],
    [
      '502 / 503',
      'Amazon refused the mail, or email is not connected yet; "message" says why in plain words.',
    ],
  ]
</script>

<svelte:head><title>{docTitle('API', 'Email')}</title></svelte:head>

<SectionHeader
  title="Send email from your app"
  description="Your website, shop or script can send mail as your company with one HTTPS request. It goes through the same senders, suppression list and logs as everything else."
/>

<div class="mt-6 grid max-w-4xl gap-8">
  <section aria-labelledby="step-key" data-testid="api-step-key">
    <h3 id="step-key" class="text-sm font-medium">
      <span class="text-muted-foreground">1.</span> Create a sending key
    </h3>
    <p class="mt-1 text-sm text-muted-foreground">
      A key is a password for your app: whoever has it can send mail as your company, nothing else.
      Make one per app, so you can revoke one without touching the others.
    </p>
    <div class="mt-3">
      <SendingKeys canManage={data.email.isAdmin} onCreated={(k) => (createdKey = k)} />
    </div>
  </section>

  <section aria-labelledby="step-send" data-testid="api-step-send">
    <h3 id="step-send" class="text-sm font-medium">
      <span class="text-muted-foreground">2.</span> Send a mail
    </h3>
    <p class="mt-1 text-sm text-muted-foreground">
      Run this in a terminal to try it{createdKey
        ? ' — it already contains your new key'
        : ' (put your key in EE_API_KEY first)'}. Your app sends the same request with its HTTP
      library.
    </p>
    {#if !data.sender}
      <p class="mt-2 text-sm text-destructive">
        Connect Amazon SES under Setup › Account first; until then the request answers 503.
      </p>
    {/if}
    <div class="relative mt-3">
      <pre
        class="overflow-x-auto rounded-lg bg-muted px-4 py-3 pr-12 font-mono text-xs leading-relaxed"
        data-testid="api-curl">{curl}</pre>
      <div class="absolute top-2 right-2">
        <CopyButton value={curl} label="Copy the example" testid="api-curl-copy" />
      </div>
    </div>
    <p class="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
      Endpoint: <code class="font-mono">{data.endpoint}</code>
      <CopyButton value={data.endpoint} label="Copy the endpoint" />
    </p>
  </section>

  <section aria-labelledby="step-check">
    <h3 id="step-check" class="text-sm font-medium">
      <span class="text-muted-foreground">3.</span> Check it arrived
    </h3>
    <p class="mt-1 text-sm text-muted-foreground">
      Every mail appears in <a class="underline underline-offset-4" href={resolve('/m/email/logs')}
        >Logs</a
      > with what happened to it — delivered, bounced, opened.
    </p>
  </section>

  <section aria-labelledby="ref-heading" class="border-t border-border pt-6">
    <h3 id="ref-heading" class="text-sm font-medium">Reference</h3>
    <p class="mt-1 text-xs text-muted-foreground">* unless you send a templateId.</p>
    <div class="mt-3 overflow-x-auto rounded-lg border border-border">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-border text-xs text-muted-foreground">
          <tr
            ><th class="px-4 py-2 font-medium">Field</th><th class="px-4 py-2 font-medium"></th><th
              class="px-4 py-2 font-medium">What it is</th
            ></tr
          >
        </thead>
        <tbody class="divide-y divide-border">
          {#each FIELDS as [name, need, what] (name)}
            <tr>
              <td class="px-4 py-2 font-mono text-xs">{name}</td>
              <td class="px-4 py-2 text-xs text-muted-foreground">{need}</td>
              <td class="px-4 py-2 text-muted-foreground">{what}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <dl class="mt-4 grid gap-2 text-sm">
      {#each ANSWERS as [code, what] (code)}
        <div class="flex gap-4">
          <dt class="w-20 shrink-0 font-mono text-xs leading-5">{code}</dt>
          <dd class="text-muted-foreground">{what}</dd>
        </div>
      {/each}
    </dl>
    <p class="mt-4 text-sm text-muted-foreground">
      Building with a coding agent? Point it at <code class="font-mono">{data.howtoUrl}</code> — it explains
      the same request for agents.
    </p>
  </section>
</div>
