<script lang="ts">
  import type { PageProps } from './$types'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import { resolve } from '$app/paths'
  import * as Alert from '$lib/components/ui/alert'
  import { Badge } from '$lib/components/ui/badge'
  import * as Card from '$lib/components/ui/card'
  import * as Table from '$lib/components/ui/table'

  let { data }: PageProps = $props()

  /**
   * Hosting: this server, read-only (D-W3). It renders what ee reports and
   * links every domain to the app or site that owns it; changes happen there.
   */

  const shortRev = (rev: string | null) => (rev ? rev.slice(0, 7) : 'not applied yet')
  const roleVariant = (role: 'Console' | 'Site' | 'App') =>
    role === 'Console' ? 'secondary' : role === 'Site' ? 'default' : 'outline'
</script>

<svelte:head><title>Hosting · Website · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-col gap-1.5 border-b border-border pb-6">
    <a href={resolve('/m/website')} class="text-xs text-foreground/55 hover:text-foreground"
      >Website</a
    >
    <h1 class="text-xl font-semibold tracking-tight">Hosting</h1>
    <p class="text-sm text-foreground/60">
      Your own server: what it serves, and under which domain.
    </p>
  </header>

  {#if !data.managed}
    <Alert.Root class="mt-6" data-testid="hosting-unmanaged">
      <Alert.Title>This server is not managed</Alert.Title>
      <Alert.Description>
        {data.reason}. Install eigenEnterprise on a server with <code>ee</code> to manage domains and
        apps here.
      </Alert.Description>
    </Alert.Root>
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
          <Card.Title>Server</Card.Title>
          <Card.Description>The two addresses this server answers to.</Card.Description>
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

      <Card.Root data-testid="hosting-domains">
        <Card.Header>
          <Card.Title>Domains</Card.Title>
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
                      <a class="underline underline-offset-2" href={row.owner.href}>
                        {row.owner.kind === 'site' ? 'Site' : row.owner.name}
                      </a>
                    {/if}
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
          <p class="text-muted-foreground mt-3 text-xs">
            Change a domain on the app or site it belongs to.
          </p>
        </Card.Content>
      </Card.Root>
    </div>
  {/if}
</div>
