<script lang="ts">
  import type { HostingData } from '../../routes/(nucleus)/m/website/settings/settings-data.server'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import { resolve } from '$app/paths'
  import * as Alert from '$lib/components/ui/alert'
  import { Badge } from '$lib/components/ui/badge'
  import * as Breadcrumb from '$lib/components/ui/breadcrumb'
  import * as Card from '$lib/components/ui/card'
  import * as Table from '$lib/components/ui/table'

  let { data }: { data: HostingData } = $props()

  /**
   * Shared settings surface for the canonical settings route and legacy hosting link.
   * Routing comes from ee; domain changes stay with the app or company site owner.
   */

  const shortRev = (rev: string | null) => (rev ? rev.slice(0, 7) : 'not applied yet')
  const roleVariant = (role: 'Console' | 'Site' | 'App') =>
    role === 'Console' ? 'secondary' : role === 'Site' ? 'default' : 'outline'
</script>

<svelte:head><title>Settings · Website · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-col gap-1.5 border-b border-border pb-6">
    <Breadcrumb.Root>
      <Breadcrumb.List>
        <Breadcrumb.Item>
          <Breadcrumb.Link href={resolve('/m/website')}>Website</Breadcrumb.Link>
        </Breadcrumb.Item>
        <Breadcrumb.Separator />
        <Breadcrumb.Item>
          <Breadcrumb.Page>Settings</Breadcrumb.Page>
        </Breadcrumb.Item>
      </Breadcrumb.List>
    </Breadcrumb.Root>
    <h1 class="text-xl font-semibold tracking-tight">Website settings</h1>
    <p class="text-sm text-foreground/60">
      Domains, routing, HTTPS and the server that runs your apps.
    </p>
  </header>

  <nav class="mt-5 flex flex-wrap gap-4 text-sm" aria-label="Website settings">
    <a class="underline underline-offset-4" href={resolve('/m/website')}>Back to repositories</a>
    <a class="underline underline-offset-4" href={resolve('/m/website/site')}
      >Company site settings</a
    >
    <a class="underline underline-offset-4" href="#domains">Domains &amp; routing</a>
    <a class="underline underline-offset-4" href="#https">HTTPS &amp; certificates</a>
  </nav>

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
        <Card.Title>Domains &amp; routing</Card.Title>
        <Card.Description
          >Live routes appear here when a deployment server is connected.</Card.Description
        >
      </Card.Header>
      <Card.Content class="text-sm text-muted-foreground">
        Manage the company domain in <a class="underline" href={resolve('/m/website/site')}
          >company site settings</a
        >. For an app, open its App settings to manage its domains. Each domain belongs to one
        destination.
      </Card.Content>
    </Card.Root>
  {:else}
    <div class="mt-6 space-y-6">
      {#if data.server.lastReconcileError}
        <Alert.Root variant="destructive" data-testid="hosting-reconcile-error">
          <Alert.Title>The server could not apply its latest change</Alert.Title>
          <Alert.Description>{data.server.lastReconcileError}</Alert.Description>
        </Alert.Root>
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
          <Card.Title>Domains &amp; routing</Card.Title>
          <Card.Description
            >Every domain pointing at this server, and what it belongs to.</Card.Description
          >
        </Card.Header>
        <Card.Content>
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Domain</Table.Head>
                <Table.Head>Role</Table.Head>
                <Table.Head>Belongs to</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each data.domains as row (row.host)}
                <Table.Row>
                  <Table.Cell>
                    <a
                      class="inline-flex items-center gap-1 underline underline-offset-2"
                      href={row.url}
                      target="_blank"
                      rel="external noopener noreferrer"
                    >
                      {row.host}
                      <ExternalLink class="size-3 shrink-0" aria-hidden="true" />
                    </a>
                  </Table.Cell>
                  <Table.Cell><Badge variant={roleVariant(row.role)}>{row.role}</Badge></Table.Cell>
                  <Table.Cell>
                    {#if row.owner.kind === 'console'}
                      Console
                    {:else}
                      <a
                        class="underline underline-offset-2"
                        href={row.owner.kind === 'app'
                          ? resolve(`/m/website/apps/${row.owner.name}#settings`)
                          : resolve('/m/website/site')}
                      >
                        {row.owner.kind === 'site' ? 'Company site' : row.owner.name}
                      </a>
                    {/if}
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
          <p class="text-muted-foreground mt-3 text-xs">
            Open an app’s Settings or Company site settings to add, change or remove its domains.
          </p>
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
        Certificate status is not reported by the deployment server. A configured route does not
        confirm that a certificate has been issued; server errors appear above.
      </p>
    </Card.Content>
  </Card.Root>
</div>
