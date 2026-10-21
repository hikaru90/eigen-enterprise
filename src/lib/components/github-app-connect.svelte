<script lang="ts" module>
  export type GitHubConnectStatusView = {
    connected: boolean
    installed: boolean
    appSlug: string | null
    /** Where the owner installs the app or manages its installation on GitHub. */
    manageUrl: string | null
  }
</script>

<script lang="ts">
  /**
   * The GitHub App connection, and nothing else (decision D-W4): create the App
   * from a manifest, install it, see that it is installed. Repos are connected
   * when you add an app — the first card says so and leads there.
   */
  import { resolve } from '$app/paths'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  let {
    github,
    manifest,
  }: {
    github: GitHubConnectStatusView
    manifest: { json: string; state: string } | null
  } = $props()

  let githubOrg = $state('')
  const manifestAction = $derived(
    manifest
      ? githubOrg.trim()
        ? `https://github.com/organizations/${encodeURIComponent(githubOrg.trim())}/settings/apps/new?state=${manifest.state}`
        : `https://github.com/settings/apps/new?state=${manifest.state}`
      : '',
  )
</script>

<Card.Root class="mt-8" data-testid="github-repos-note">
  <Card.Header>
    <Card.Title>Repos are connected when you add an app</Card.Title>
    <Card.Description>
      A public repo needs nothing but its link. A private repo gets a read-only deploy key during
      that step. The GitHub App below is only for the extras: picking repos without pasting links,
      and deploying on push.
    </Card.Description>
  </Card.Header>
  <Card.Content>
    <Button href={resolve('/m/website/apps/new')} data-testid="github-add-app-link"
      >Add an app from a repo</Button
    >
  </Card.Content>
</Card.Root>

<Card.Root class="mt-6" data-testid="github-connect-app">
  <Card.Header>
    <Card.Title>Connect through a GitHub App</Card.Title>
    <Card.Description>
      An app on your GitHub account that can list and read the repos you pick — only the repos you
      choose, and only read.
    </Card.Description>
  </Card.Header>
  <Card.Content>
    {#if !github.connected && manifest}
      <ol class="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Click “Connect GitHub”. GitHub opens and shows a ready-made app for your company.</li>
        <li>Click “Create GitHub App” there. It can only read code, and only of repos you pick.</li>
        <li>
          GitHub then asks where to install it: pick your account or organization and the repos.
        </li>
        <li>You come back here and the app shows as connected.</li>
      </ol>
      <form method="POST" action={manifestAction} class="mt-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="manifest" value={manifest.json} />
        <Label class="min-w-48 flex-1" for="github-org">
          GitHub organization (leave empty for your personal account)
          <Input
            id="github-org"
            bind:value={githubOrg}
            name="org"
            class="mt-1"
            autocomplete="off"
          />
        </Label>
        <Button type="submit" data-testid="github-connect-start">Connect GitHub</Button>
      </form>
    {:else if github.connected && !github.installed}
      <p class="text-sm text-muted-foreground" data-testid="github-app-not-installed">
        The app <strong>{github.appSlug}</strong> exists but is not installed yet.
        <a class="underline" rel="external" href={github.manageUrl}
          >Install it on your repositories</a
        >.
      </p>
    {:else}
      <p
        class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
        data-testid="github-connected"
      >
        <Badge data-testid="github-installed-badge">Installed</Badge>
        <span> Connected through the GitHub App <strong>{github.appSlug}</strong>.</span>
      </p>
      {#if github.manageUrl}
        <a
          class="mt-2 inline-block text-sm underline"
          rel="external"
          href={github.manageUrl}
          data-testid="github-manage-link">Manage the installation on GitHub</a
        >
      {/if}
    {/if}
  </Card.Content>
</Card.Root>
