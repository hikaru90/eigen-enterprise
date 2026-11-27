<script lang="ts">
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import AppPreview from '$lib/components/drive/app-preview.svelte'
  import ArchiveBanner from '$lib/components/drive/archive-banner.svelte'
  import DriveBrowser from '$lib/components/drive/drive-browser.svelte'
  import { Button } from '$lib/components/ui/button'
  import { GITHUB_SOURCE, githubButtonLabel } from '$lib/drive/sections'
  import { getCompanyPresence } from '$lib/presence/company-presence.svelte'
  import { declarePresenceFocus } from '$lib/presence/focus.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
  /** Who has which row open (plan/phase-multiplayer-presence.md); null while the presence feed is off. */
  const company = getCompanyPresence()
  // Where I am (plan/phase-multiplayer-presence.md): this folder is the page's open item.
  declarePresenceFocus(() => (data.listing.folder ? { kind: 'drive_folder', id: data.listing.folder.id } : null))
  /** In the GitHub folder's tree, for those who may connect repos: the way to the settings (Drive → GitHub). */
  const github = $derived.by(() => {
    if (!data.github) return null
    const root = data.sources.find((s) => s.source === GITHUB_SOURCE)
    return root && root.href === data.listing.root.href ? githubButtonLabel(data.github.connectedRepos) : null
  })
</script>

<svelte:head><title>{docTitle(data.listing.folder?.name, 'Drive')}</title></svelte:head>

{#if data.listing.folder}
  <ArchiveBanner
    item={data.listing.folder}
    archivedIn={data.listing.archivedIn}
    canEdit={data.listing.canEdit}
  />
{/if}

{#if github}
  <div class="flex justify-end px-4 pt-4 md:px-6" data-testid="drive-github-manage">
    <Button href={resolve('/drive/github')} variant="outline" size="sm">{github}</Button>
  </div>
{/if}

{#key data.listing.folder?.id}
  {#if data.listing.folder}
    <AppPreview folderId={data.listing.folder.id} canRun={data.shell?.capabilities['drive.run_apps'] ?? false} />
  {/if}
  <DriveBrowser
    {company}
    folderId={data.listing.folder?.id ?? null}
    path={data.listing.path}
    root={data.listing.root}
    items={data.listing.items}
    canEdit={data.listing.canEdit}
    query={data.query}
    results={data.results}
    describe={data.describe}
    emptyText="This folder is empty."
  />
{/key}
