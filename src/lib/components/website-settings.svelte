<script lang="ts">
  import type {
    HostingData,
    HostingDomainSummary,
  } from '../../routes/(nucleus)/m/website/settings/settings-data.server'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import * as Alert from '$lib/components/ui/alert'
  import * as Card from '$lib/components/ui/card'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: HostingData } = $props()

  /**
   * Shared settings surface for the canonical settings route and legacy hosting link.
   * Domains are a global setting: a summary here, everything else in Settings › Domains.
   */

  const shortRev = (rev: string | null) => (rev ? rev.slice(0, 7) : 'not applied yet')
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  /** "4 addresses point at this server: the console, the company website, 1 app and calls." */
  function summary(d: HostingDomainSummary): string {
    if (d.total === 0) return 'No address points at this server yet.'
    const parts = [
      d.console ? 'the console' : null,
      d.site ? 'the company website' : null,
      d.apps ? plural(d.apps, 'app', 'apps') : null,
      d.calls ? 'calls' : null,
    ].filter((p): p is string => p !== null)
    const list =
      parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
    return `${plural(d.total, 'address points', 'addresses point')} at this server: ${list}.`
  }
</script>

<svelte:head><title>{docTitle('Settings', 'Website')}</title></svelte:head>

<div class="max-w-3xl">
  <SectionHeader
    title="Settings"
    description="Domains, routing, HTTPS and the server that runs your apps."
  />

  {#if !data.managed}
    <Alert.Root class="mt-6" data-testid="hosting-unmanaged">
      <Alert.Title>Deployment server not connected</Alert.Title>
      <Alert.Description>
        Repositories can be connected here. Building apps and applying domain routes requires this
        console to run on a server installed with ee. Open your server's console to deploy.
        <details class="mt-3">
          <summary class="cursor-pointer">Connection details</summary>
          <p class="mt-2 break-words font-mono text-xs">{data.reason}</p>
        </details>
      </Alert.Description>
    </Alert.Root>
    <Card.Root class="mt-6" id="domains">
      <Card.Header>
        <Card.Title>Domains</Card.Title>
        <Card.Description
          >What points at this server appears here when a deployment server is connected.</Card.Description
        >
      </Card.Header>
      <Card.Content class="text-sm text-muted-foreground">
        The company’s domains are in <a class="underline" href={resolve('/settings/domains')}
          >Settings › Domains</a
        >. Each address shows one thing: the console, the company website, an app or nothing.
      </Card.Content>
    </Card.Root>
  {:else}
    <div class="mt-6 space-y-6">
      {#if data.server.lastReconcileError}
        <ErrorNotice
          class="rounded-lg border border-destructive/40 px-4 py-3"
          testid="hosting-reconcile-error"
          title="The server could not apply its latest change"
          error={data.server.lastReconcileError}
          attempted="ee applying the server's latest desired state (reconcile), shown in Website → Settings; `ee status` and the ee journal on the server have the full error"
        />
      {/if}

      <Card.Root data-testid="hosting-server">
        <Card.Header>
          <Card.Title>Deployment server</Card.Title>
          <Card.Description
            >Current server addresses and the revisions ee is applying.</Card.Description
          >
        </Card.Header>
        <Card.Content>
          <dl class="text-sm">
            <div class="flex items-baseline justify-between gap-4 py-1.5">
              <dt class="text-muted-foreground">Console</dt>
              <dd>
                <a
                  class="underline underline-offset-2"
                  href={data.server.consoleUrl}
                  target="_blank"
                  rel="external noopener noreferrer">{data.server.consoleHost}</a
                >
              </dd>
            </div>
            <div class="flex items-baseline justify-between gap-4 py-1.5">
              <dt class="text-muted-foreground">Site</dt>
              <dd>
                {#if data.server.siteHost}
                  <a
                    class="underline underline-offset-2"
                    href="https://{data.server.siteHost}"
                    target="_blank"
                    rel="external noopener noreferrer">{data.server.siteHost}</a
                  >
                {:else}
                  <span class="text-muted-foreground">no domain yet</span>
                {/if}
              </dd>
            </div>
            <div class="flex items-baseline justify-between gap-4 py-1.5">
              <dt class="text-muted-foreground">Revision</dt>
              <dd class="tabular-nums">
                {shortRev(data.server.appliedRev)} applied · {shortRev(data.server.desiredRev)}
                desired
              </dd>
            </div>
          </dl>
        </Card.Content>
      </Card.Root>

      <Card.Root id="domains" data-testid="hosting-domains">
        <Card.Header>
          <Card.Title>Domains</Card.Title>
          <Card.Description>{summary(data.domains)}</Card.Description>
        </Card.Header>
        <Card.Content class="text-sm text-muted-foreground">
          Every address, what it shows, its DNS records and its certificate are in
          <a class="underline underline-offset-2" href={resolve('/settings/domains')}
            >Settings › Domains</a
          >, the one place to change them.
        </Card.Content>
      </Card.Root>
    </div>
  {/if}

  <Card.Root class="mt-6" id="https">
    <Card.Header>
      <Card.Title>HTTPS &amp; certificates</Card.Title>
      <Card.Description
        >Automatic certificate management by Caddy on your deployment server.</Card.Description
      >
    </Card.Header>
    <Card.Content class="space-y-3 text-sm text-muted-foreground">
      <p>
        For public domains, Caddy requests and renews TLS certificates automatically. Point your
        domain’s DNS records at the server and make ports 80 and 443 reachable before adding it.
      </p>
      <p>
        Local test domains use Caddy’s local certificate authority and need its root certificate
        trusted on your device.
      </p>
      <p>
        Each address’s certificate — issued, pending, or failing with the last error and the next
        try — is shown in <a
          class="underline underline-offset-2"
          href={resolve('/settings/domains')}>Settings › Domains</a
        >, with “Retry certificate”.
      </p>
    </Card.Content>
  </Card.Root>
</div>
