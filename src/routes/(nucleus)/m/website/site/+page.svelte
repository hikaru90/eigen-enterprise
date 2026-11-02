<script lang="ts">
  import type { PageProps } from './$types'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import * as Alert from '$lib/components/ui/alert'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import * as Breadcrumb from '$lib/components/ui/breadcrumb'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Input as TextInput } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: PageProps = $props()

  /**
   * The company site's domain (D-W1): one site, one public address. The
   * domain is the owner's click (D11 — the click runs the human-only
   * substrate tools).
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

<svelte:head><title>{docTitle('Company site', 'Website')}</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-col gap-1.5 border-b border-border pb-6">
    <Breadcrumb.Root>
      <Breadcrumb.List>
        <Breadcrumb.Item>
          <Breadcrumb.Link href={resolve('/m/website')}>Website</Breadcrumb.Link>
        </Breadcrumb.Item>
        <Breadcrumb.Separator />
        <Breadcrumb.Item>
          <Breadcrumb.Link href={resolve('/m/website/settings')}>Settings</Breadcrumb.Link>
        </Breadcrumb.Item>
        <Breadcrumb.Separator />
        <Breadcrumb.Item><Breadcrumb.Page>Company site</Breadcrumb.Page></Breadcrumb.Item>
      </Breadcrumb.List>
    </Breadcrumb.Root>
    <h1 class="text-xl font-semibold tracking-tight">Company site settings</h1>
    <p class="text-sm text-foreground/60">Your company's public address.</p>
  </header>

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
        <Card.Description>The address the site is served under.</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-3">
        {#if !data.managed}
          <Alert.Root data-testid="site-unmanaged">
            <Alert.Title>Connect a deployment server to set the domain</Alert.Title>
            <Alert.Description>
              Domain changes require ee on the server running this console.
              <a class="underline" href={resolve('/m/website/settings')}
                >View server connection details</a
              >.
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
            Point the domain’s A or AAAA DNS records at this server. Caddy requests and renews HTTPS
            certificates automatically when DNS and ports 80/443 are reachable.
            <a class="underline" href={resolve('/m/website/settings#https')}>HTTPS settings</a>.
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
  </div>
</div>
