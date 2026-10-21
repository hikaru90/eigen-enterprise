<script lang="ts">
  import type { PageProps } from './$types'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import * as Alert from '$lib/components/ui/alert'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { Badge } from '$lib/components/ui/badge'
  import * as Breadcrumb from '$lib/components/ui/breadcrumb'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Input as TextInput } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import * as Table from '$lib/components/ui/table'

  let { data, form }: PageProps = $props()

  /**
   * The company site as a service (D-W1): one site, its domain and its pages.
   * Pages are written in chat; the domain is the owner's click (D11 — the
   * click runs the human-only substrate tools).
   */

  let changing = $state(false)
  let removing = $state(false)

  const hasOwnDomain = $derived(data.managed && data.publicHost !== null)
  const message = (action: string) =>
    form && 'action' in form && form.action === action
      ? 'error' in form && form.error
        ? { kind: 'error' as const, text: form.error }
        : 'reconcileError' in form && form.reconcileError
          ? {
              kind: 'error' as const,
              text: `Saved, but the server could not apply it: ${form.reconcileError}`,
            }
          : { kind: 'ok' as const, text: 'Done.' }
      : null

  function doneClosingChange(): ({ update }: { update: () => Promise<void> }) => Promise<void> {
    return async ({ update }) => {
      await update()
      changing = false
    }
  }
</script>

<svelte:head><title>Site · Website · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-col gap-1.5 border-b border-border pb-6">
    <Breadcrumb.Root>
      <Breadcrumb.List>
        <Breadcrumb.Item>
          <Breadcrumb.Link href={resolve('/m/website')}>Website</Breadcrumb.Link>
        </Breadcrumb.Item>
        <Breadcrumb.Separator />
        <Breadcrumb.Item>
          <Breadcrumb.Page>Site</Breadcrumb.Page>
        </Breadcrumb.Item>
      </Breadcrumb.List>
    </Breadcrumb.Root>
    <h1 class="text-xl font-semibold tracking-tight">Site</h1>
    <p class="text-sm text-foreground/60">
      Your company's public website: its address and its pages.
    </p>
  </header>

  <div class="mt-6 space-y-6">
    <Card.Root data-testid="site-address">
      <Card.Header>
        <Card.Title>Your site</Card.Title>
        <Card.Description>Where visitors find you.</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-2">
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
      </Card.Content>
    </Card.Root>

    <Card.Root data-testid="site-domain">
      <Card.Header>
        <Card.Title>Domain</Card.Title>
        <Card.Description>The address the site is served under.</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-3">
        {#if !data.managed}
          <Alert.Root data-testid="site-unmanaged">
            <Alert.Title>This server is not managed</Alert.Title>
            <Alert.Description>
              {data.reason}. Install eigenEnterprise on a server with <code>ee</code> to give the site
              its own domain.
            </Alert.Description>
          </Alert.Root>
        {:else if hasOwnDomain}
          {#if changing}
            <form
              method="POST"
              action="?/domainSet"
              use:enhance={doneClosingChange}
              class="space-y-2"
            >
              <Label for="site-domain-input">Domain</Label>
              <div class="flex flex-wrap items-center gap-2">
                <TextInput
                  id="site-domain-input"
                  name="host"
                  value={data.publicHost ?? ''}
                  required
                  placeholder="kindred.digital"
                  class="max-w-xs"
                />
                <Button type="submit" size="sm">Save</Button>
                <Button type="button" size="sm" variant="ghost" onclick={() => (changing = false)}>
                  Cancel
                </Button>
              </div>
            </form>
          {:else}
            <div class="flex flex-wrap items-center gap-3">
              <span class="text-sm" data-testid="site-domain-current">{data.publicHost}</span>
              <Button type="button" size="sm" variant="outline" onclick={() => (changing = true)}>
                Change
              </Button>
              <Button type="button" size="sm" variant="ghost" onclick={() => (removing = true)}>
                Remove
              </Button>
            </div>
          {/if}
        {:else}
          <form method="POST" action="?/domainSet" use:enhance class="space-y-2">
            <Label for="site-domain-input">Add a domain</Label>
            <div class="flex flex-wrap items-center gap-2">
              <TextInput
                id="site-domain-input"
                name="host"
                required
                placeholder="kindred.digital"
                class="max-w-xs"
              />
              <Button type="submit" size="sm">Add domain</Button>
            </div>
          </form>
        {/if}

        {#if data.managed}
          <p class="text-muted-foreground text-xs">
            The address must point at this server (an A record) before it works; the certificate is
            requested automatically.
          </p>
          {#snippet feedback(action: string)}
            {@const m = message(action)}
            {#if m}
              <p
                class="text-xs {m.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}"
                data-testid="site-feedback-{action}"
              >
                {m.text}
              </p>
            {/if}
          {/snippet}
          {@render feedback('domainSet')}
          {@render feedback('domainRemove')}

          <AlertDialog.Root bind:open={removing}>
            <AlertDialog.Content>
              <AlertDialog.Header>
                <AlertDialog.Title>Remove {data.publicHost}?</AlertDialog.Title>
                <AlertDialog.Description>
                  The site will no longer be served under this address. Point it somewhere else, or
                  add it again here later.
                </AlertDialog.Description>
              </AlertDialog.Header>
              <AlertDialog.Footer>
                <AlertDialog.Cancel>Keep it</AlertDialog.Cancel>
                <form method="POST" action="?/domainRemove">
                  <input type="hidden" name="host" value={data.publicHost ?? ''} />
                  <Button type="submit" variant="destructive" size="sm">Remove domain</Button>
                </form>
              </AlertDialog.Footer>
            </AlertDialog.Content>
          </AlertDialog.Root>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root data-testid="site-pages">
      <Card.Header>
        <Card.Title>Pages</Card.Title>
        <Card.Description>
          Pages are written in chat — ask there to create, change or publish one.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if data.pages.length === 0}
          <p class="text-sm text-muted-foreground">No pages yet — ask in chat to create one.</p>
        {:else}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>Title</Table.Head>
                <Table.Head>Slug</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head><span class="sr-only">Open</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each data.pages as page (page.slug)}
                <Table.Row>
                  <Table.Cell>{page.title}</Table.Cell>
                  <Table.Cell class="text-muted-foreground">/{page.slug}</Table.Cell>
                  <Table.Cell>
                    <Badge variant={page.status === 'published' ? 'default' : 'outline'}>
                      {page.status === 'published' ? 'Published' : 'Draft'}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <a
                      class="inline-flex items-center gap-1 underline underline-offset-2"
                      href={page.url}
                      target="_blank"
                      rel="external noopener noreferrer"
                    >
                      Open
                      <ExternalLink class="size-3 shrink-0" aria-hidden="true" />
                    </a>
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        {/if}
      </Card.Content>
    </Card.Root>
  </div>
</div>
