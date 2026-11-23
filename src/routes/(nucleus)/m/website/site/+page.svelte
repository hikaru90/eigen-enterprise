<script lang="ts">
  import type { PageProps } from './$types'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import { resolve } from '$app/paths'
  import HostAddresses from '$lib/components/domains/host-addresses.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import * as Alert from '$lib/components/ui/alert'
  import * as Card from '$lib/components/ui/card'
  import { docTitle } from '$lib/shell/title'

  let { data }: PageProps = $props()

  /**
   * The company site (D-W1): one site, its address(es) with their status.
   * Domains are a global setting edited only in Settings › Domains
   * (plan/domains-one-claim.md); this page shows and links.
   */
</script>

<svelte:head><title>{docTitle('Company site', 'Website')}</title></svelte:head>

<div class="min-w-0">
  <SectionHeader title="Company site" description="Your company's public address." />

  <div class="mt-6 space-y-6">
    <Card.Root data-testid="site-address">
      <Card.Header>
        <Card.Title>Your site</Card.Title>
        <Card.Description>Where visitors find you.</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-2">
        {#if data.siteUrl}
          <a
            class="inline-flex items-center gap-1.5 text-base underline underline-offset-4"
            href={data.siteUrl}
            target="_blank"
            rel="external noopener noreferrer"
          >
            {data.siteUrl}
            <ExternalLink class="size-4 shrink-0" aria-hidden="true" />
          </a>
          {#if data.managed && !data.publicHost}
            <p class="text-muted-foreground text-xs">
              The site has no domain of its own yet; it lives at the console's address.
            </p>
          {/if}
        {:else}
          <p class="text-sm text-muted-foreground">
            No public address is reported by a deployment server.
          </p>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root data-testid="site-domain">
      <Card.Header>
        <Card.Title>Domain</Card.Title>
        <Card.Description>
          The addresses the site is served under. Domains are set for the whole company in Settings
          › Domains.
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-3">
        {#if !data.managed}
          <Alert.Root data-testid="site-unmanaged">
            <Alert.Title>Connect a deployment server to give the site a domain</Alert.Title>
            <Alert.Description>
              Domains need ee on the server running this console.
              <a class="underline" href={resolve('/m/website/settings')}
                >View server connection details</a
              >.
            </Alert.Description>
          </Alert.Root>
        {:else}
          <HostAddresses
            addresses={data.addresses}
            error={data.addressesError}
            empty="No address shows the company website yet."
          />
        {/if}
      </Card.Content>
    </Card.Root>
  </div>
</div>
