<script lang="ts">
  import type { PageProps } from './$types'
  import type { SubmitFunction } from '@sveltejs/kit'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { docTitle } from '$lib/shell/title'

  /** GitHub repos: paste a read-only token, pick repos, see how each sync went. Admin only. */
  let { data, form }: PageProps = $props()

  type Feedback = { action?: string; ok?: boolean; error?: string; login?: string; fullName?: string; status?: string }
  const feedback = (action: string): Feedback | null =>
    form && (form as Feedback).action === action ? (form as Feedback) : null

  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—'
  const time = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'not yet'
  const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const paused = (iso: string | null) => iso !== null && new Date(iso).getTime() > Date.now()

  const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'

  /** Unticking deletes the repo's Drive folder: ask first. */
  const confirmToggle =
    (fullName: string, syncing: boolean): SubmitFunction =>
    ({ formElement, cancel }) => {
      if (
        syncing &&
        !confirm(
          `Stop syncing ${fullName}? Its folder in Drive (GitHub / ${fullName}) will be deleted. The repo on GitHub is not touched.`,
        )
      ) {
        const box = formElement.querySelector('input[type="checkbox"]') as HTMLInputElement | null
        if (box) box.checked = true
        cancel()
      }
    }

  const confirmRemove =
    (login: string, count: number): SubmitFunction =>
    ({ cancel }) => {
      if (
        !confirm(
          `Remove the GitHub token of ${login}? ${count === 0 ? 'No repo syncs through it.' : `Its ${count} repo${count === 1 ? '' : 's'} stop syncing and their folders in Drive will be deleted.`} The repos on GitHub are not touched.`,
        )
      )
        cancel()
    }

  function submitOnChange(e: Event & { currentTarget: HTMLInputElement }) {
    e.currentTarget.form?.requestSubmit()
  }
</script>

<svelte:head><title>{docTitle('GitHub repos')}</title></svelte:head>

{#snippet steps()}
  <ol class="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
    <li>
      On GitHub, open
      <a class="underline" href={NEW_TOKEN_URL} target="_blank" rel="noopener noreferrer"
        >Settings → Developer settings → Fine-grained tokens → Generate new token</a
      >.
    </li>
    <li>
      <span class="text-foreground">Resource owner:</span> your account, or the organisation that owns
      the repos. One token covers one owner; add another token for another owner.
    </li>
    <li><span class="text-foreground">Repository access:</span> Only select repositories.</li>
    <li>
      <span class="text-foreground">Permissions:</span> Contents: Read-only and Pull requests: Read-only
      (GitHub adds Metadata: Read-only). Nothing else.
    </li>
    <li>Generate the token, copy it and paste it below.</li>
  </ol>
{/snippet}

{#snippet pasteForm(action: string, tokenId: string | null, label: string)}
  <form
    method="POST"
    action={`?/${action}`}
    class="mt-4 flex max-w-2xl flex-wrap items-end gap-3"
    use:enhance
    data-testid={`repos-${action}`}
  >
    {#if tokenId}<input type="hidden" name="tokenId" value={tokenId} />{/if}
    <div class="grid min-w-72 flex-1 gap-1.5">
      <Label for={`token-${action}-${tokenId ?? 'new'}`}>Fine-grained token</Label>
      <Input
        id={`token-${action}-${tokenId ?? 'new'}`}
        name="token"
        type="password"
        autocomplete="off"
        spellcheck={false}
        required
        placeholder="github_pat_…"
      />
    </div>
    <Button type="submit">{label}</Button>
  </form>
{/snippet}

<PageFrame testid="repos-area">
  <PageHeader
    title="GitHub repos"
    description="Read-only copies of your GitHub repos in Drive: branches, pull requests, recent activity and the Markdown docs, kept in sync every 15 minutes. eigenEnterprise never writes to GitHub."
    status={{ label: data.active ? 'Active' : 'Not active', on: data.active }}
  />

  {#if data.summaryNoModel}
    <p
      class="mt-4 max-w-2xl rounded-md border border-border px-4 py-3 text-sm"
      role="status"
      data-testid="repos-summary-no-model"
    >
      <span class="font-medium">No model is selected for summaries.</span>
      <span class="text-muted-foreground">
        The repos still sync into Drive; only the assistant's "What's going on" summary is missing.
        The owner selects a model under <a class="underline" href={resolve('/settings/llm')}>Settings → AI provider</a>.
      </span>
    </p>
  {/if}

  {#if feedback('removeToken')?.ok}
    <p class="mt-4 text-sm text-muted-foreground" role="status">The token was removed.</p>
  {/if}
  {#if feedback('removeToken')?.error}
    <p class="mt-4 text-sm text-destructive" role="alert">{feedback('removeToken')?.error}</p>
  {/if}

  {#each data.tokens as t (t.id)}
    <section
      class="mt-6 rounded-lg border border-border p-4 sm:p-5"
      data-testid={`repos-token-${t.login}`}
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-base font-semibold">Token of {t.login}</h2>
          <p class="mt-0.5 text-sm text-muted-foreground" data-testid="repos-token-meta">
            …{t.last4} · {t.expiresAt ? `expires ${date(t.expiresAt)}` : 'no expiry date'} · added {date(
              t.createdAt,
            )}
          </p>
        </div>
        <form
          method="POST"
          action="?/removeToken"
          use:enhance={confirmRemove(t.login, t.repos.length)}
        >
          <input type="hidden" name="tokenId" value={t.id} />
          <Button type="submit" variant="ghost" size="sm">Remove token</Button>
        </form>
      </div>

      {#if t.lastError}
        <p class="mt-3 text-sm text-destructive" role="alert">{t.lastError}</p>
      {:else if t.expired}
        <p class="mt-3 text-sm text-destructive" role="alert">
          This token expired on {date(t.expiresAt)}. Create a new one and paste it below.
        </p>
      {:else if t.expiresSoon}
        <p class="mt-3 text-sm text-amber-600 dark:text-amber-400" role="status">
          This token expires on {date(t.expiresAt)}. Create a new one on GitHub and replace it
          before then, or its repos stop syncing.
        </p>
      {/if}

      {#if t.repos.length > 0}
        <h3 class="mt-5 text-sm font-medium">Syncing</h3>
        <ul class="mt-2 divide-y divide-border rounded-md border border-border">
          {#each t.repos as r (r.id)}
            <li
              class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5"
              data-testid={`repos-status-${r.fullName}`}
            >
              <span class="min-w-0 flex-1 truncate text-sm font-medium">{r.fullName}</span>
              <span class="text-xs text-muted-foreground">
                Last synced {time(r.lastSyncedAt)}
                {#if paused(r.pausedUntil)}
                  · Paused until {clock(r.pausedUntil!)} (GitHub's rate limit)
                {:else}
                  · next {time(r.nextDueAt)}
                {/if}
              </span>
              <form method="POST" action="?/syncNow" use:enhance>
                <input type="hidden" name="sourceId" value={r.id} />
                <Button type="submit" size="sm" variant="outline">Sync now</Button>
              </form>
              {#if r.lastError}
                <p class="w-full text-xs text-destructive">{r.lastError}</p>
              {/if}
              <p class="w-full text-xs text-muted-foreground" data-testid="repos-summary-status">
                {#if r.summary.problem?.kind === 'failed'}
                  <span class="text-destructive"
                    >Summary {r.summary.writtenAt ? 'out of date' : 'missing'}: updating it failed {time(
                      r.summary.problem.at,
                    )}. {r.summary.problem.message}</span
                  >
                {:else if r.summary.problem?.kind === 'no_model'}
                  Summary {r.summary.writtenAt ? `from ${time(r.summary.writtenAt)}, out of date` : 'missing'}:
                  no model is selected for summaries.
                {:else if r.summary.writtenAt}
                  Summary written by the assistant {time(r.summary.writtenAt)}.
                {:else}
                  No summary yet: the assistant writes one after a sync that finds changes.
                {/if}
              </p>
            </li>
          {/each}
        </ul>
      {/if}
      {#if feedback('syncNow')?.error}
        <p class="mt-2 text-sm text-destructive" role="alert">{feedback('syncNow')?.error}</p>
      {:else if feedback('syncNow')?.ok}
        <p class="mt-2 text-sm text-muted-foreground" role="status">
          {feedback('syncNow')?.status === 'queued'
            ? `${feedback('syncNow')?.fullName} is syncing already.`
            : `Synced ${feedback('syncNow')?.fullName}.`}
        </p>
      {/if}

      {#if !t.lastError && !t.expired}
        <h3 class="mt-5 text-sm font-medium">Repos this token can see</h3>
        {#if t.visibleError}
          <p class="mt-2 text-sm text-destructive" role="alert">{t.visibleError}</p>
        {:else if t.visible.length === 0}
          <p class="mt-2 max-w-2xl text-sm text-muted-foreground" data-testid="repos-none-visible">
            This token can't see any repo yet. If an organisation owns the repos, it may have to
            approve fine-grained tokens first: an owner of the organisation approves it on GitHub
            under the organisation's Settings → Personal access tokens → Pending requests. Check
            too that you selected the repos when you created the token.
          </p>
        {:else}
          <p class="mt-1 text-xs text-muted-foreground">
            Ticked repos sync into Drive under GitHub / owner / repo, read-only and visible to the
            whole company.
          </p>
          <ul class="mt-2 divide-y divide-border rounded-md border border-border">
            {#each t.visible as v (v.id)}
              <li class="px-4 py-2">
                <form
                  method="POST"
                  action="?/setRepo"
                  use:enhance={confirmToggle(v.fullName, v.syncing)}
                  class="flex items-center gap-3"
                >
                  <input type="hidden" name="tokenId" value={t.id} />
                  <input type="hidden" name="repoId" value={v.id} />
                  <input type="hidden" name="syncing" value={String(!v.syncing)} />
                  <input
                    id={`repo-${v.id}`}
                    type="checkbox"
                    class="size-4"
                    checked={v.syncing}
                    onchange={submitOnChange}
                    data-testid={`repos-pick-${v.fullName}`}
                  />
                  <label for={`repo-${v.id}`} class="min-w-0 flex-1 truncate text-sm"
                    >{v.fullName}</label
                  >
                  {#if v.private}<span class="text-xs text-muted-foreground">private</span>{/if}
                  {#if v.archived}<span class="text-xs text-muted-foreground"
                      >archived on GitHub</span
                    >{/if}
                </form>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
      {#if feedback('setRepo')?.error}
        <p class="mt-2 text-sm text-destructive" role="alert">{feedback('setRepo')?.error}</p>
      {/if}

      <details class="mt-5">
        <summary class="cursor-pointer text-sm font-medium">Replace token</summary>
        <p class="mt-2 text-sm text-muted-foreground">
          Paste a new fine-grained token for {t.login}. The repos keep syncing with it.
        </p>
        {@render steps()}
        {@render pasteForm('replaceToken', t.id, 'Replace token')}
        {#if feedback('replaceToken')?.error}
          <p class="mt-2 text-sm text-destructive" role="alert">
            {feedback('replaceToken')?.error}
          </p>
        {/if}
      </details>
    </section>
  {/each}

  <section class="mt-6" data-testid="repos-add">
    <SectionHeader
      title={data.tokens.length === 0 ? 'Connect GitHub' : 'Add a token for another owner'}
      description="eigenEnterprise reads your repos with a fine-grained personal access token that can only read. Classic tokens are refused: they can change every repo you can."
    />
    {@render steps()}
    {@render pasteForm('addToken', null, 'Check and save')}
    {#if feedback('addToken')?.error}
      <p class="mt-2 text-sm text-destructive" role="alert">{feedback('addToken')?.error}</p>
    {:else if feedback('addToken')?.ok}
      <p class="mt-2 text-sm text-muted-foreground" role="status">
        Connected the token of {feedback('addToken')?.login}. Tick the repos to sync.
      </p>
    {/if}
  </section>
</PageFrame>
