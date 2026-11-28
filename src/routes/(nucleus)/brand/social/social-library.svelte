<script lang="ts">
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import type { ShownError } from '$lib/errors/agent-report'
  import { cn } from '$lib/utils.js'
  import {
    SOCIAL_NETWORK_LABELS,
    SOCIAL_STATUS_LABELS,
    SOCIAL_STATUSES,
    type SocialPost,
    type SocialPostStatus,
  } from '../../../../../modules/brand/social/types'
  import { brandShownError } from '../brand-errors'
  import { ASSISTANT_PREFILL, mediaUrl, socialApi, type SocialApi } from './social-api'
  import SocialGraphicView from './social-graphic.svelte'
  import { renderPdfPages, type PdfPages } from './social-pdf'
  import SocialPostEditor from './social-post-editor.svelte'
  import SocialUploadDialog from './social-upload-dialog.svelte'

  /**
   * Brand › Social: the company's posts collected in its style. Posts are made
   * with the assistant (it drafts branded graphics through the brand.social_*
   * tools), as a new graphic here, or uploaded ready-made. Pick a post to edit
   * it, get caption suggestions in the brand voice, and download its media.
   */
  type Style = {
    name: string
    cssVars: Record<string, string>
    darkCssVars: Record<string, string> | null
  }

  let {
    posts: initialPosts,
    style,
    activeLocales,
    assistantOn,
    selected: initialSelected = null,
    api = socialApi(),
    pdfPages = renderPdfPages,
  }: {
    posts: SocialPost[]
    style: Style | null
    activeLocales: string[]
    assistantOn: boolean
    selected?: string | null
    api?: SocialApi
    pdfPages?: PdfPages
  } = $props()

  // svelte-ignore state_referenced_locally
  let posts = $state<SocialPost[]>(initialPosts)
  // svelte-ignore state_referenced_locally
  let selectedId = $state<string | null>(
    initialSelected && initialPosts.some((p) => p.id === initialSelected) ? initialSelected : null,
  )
  let filter = $state<SocialPostStatus | 'all'>('all')
  let uploadOpen = $state(false)
  let error = $state<ShownError | null>(null)
  let creating = $state(false)

  const shown = $derived(filter === 'all' ? posts : posts.filter((p) => p.status === filter))
  const selected = $derived(posts.find((p) => p.id === selectedId) ?? null)
  const counts = $derived(
    Object.fromEntries(SOCIAL_STATUSES.map((s) => [s, posts.filter((p) => p.status === s).length])),
  )

  function replace(post: SocialPost) {
    posts = posts.some((p) => p.id === post.id)
      ? posts.map((p) => (p.id === post.id ? post : p))
      : [post, ...posts]
  }

  async function newGraphic() {
    creating = true
    error = null
    try {
      const post = await api.createGraphic({
        title: 'New post',
        format: 'square',
        graphic: { headline: 'Your headline', body: '', cta: '', mode: 'light' },
        networks: ['instagram', 'linkedin'],
      })
      replace(post)
      selectedId = post.id
      filter = 'all'
    } catch (err) {
      error = brandShownError(err)
    } finally {
      creating = false
    }
  }

  function day(iso: string) {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  }
</script>

<div class="flex flex-col gap-6">
  <div class="flex flex-wrap items-center gap-2">
    {#if assistantOn}
      <Button
        href={`?prefill=${encodeURIComponent(ASSISTANT_PREFILL)}`}
        data-testid="social-assistant">Create with assistant</Button
      >
    {/if}
    <Button variant="outline" onclick={newGraphic} disabled={!style || creating}>New graphic</Button
    >
    <Button variant="outline" onclick={() => (uploadOpen = true)}>Upload a post</Button>
    <span class="flex-1"></span>
    <p class="text-xs text-muted-foreground" data-testid="social-not-connected">
      Posting to the networks isn’t connected yet.
    </p>
  </div>
  {#if !style}
    <p class="text-sm text-muted-foreground">
      Graphics are drawn from your active style. <a class="underline" href={resolve('/brand')}
        >Choose a style</a
      > to make one.
    </p>
  {/if}
  {#if error}
    <ErrorNotice
      error={error.error}
      agent={error.agent}
      attempted="Creating a social post (Brand › Social)"
    />
  {/if}

  <div class="flex flex-wrap gap-1" role="group" aria-label="Status">
    <Button
      size="sm"
      variant={filter === 'all' ? 'secondary' : 'ghost'}
      aria-pressed={filter === 'all'}
      onclick={() => (filter = 'all')}
    >
      All · {posts.length}
    </Button>
    {#each SOCIAL_STATUSES as s (s)}
      <Button
        size="sm"
        variant={filter === s ? 'secondary' : 'ghost'}
        aria-pressed={filter === s}
        onclick={() => (filter = s)}
      >
        {SOCIAL_STATUS_LABELS[s]} · {counts[s]}
      </Button>
    {/each}
  </div>

  {#if posts.length === 0}
    <div
      class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-16 text-center"
      data-testid="social-empty"
    >
      <h3 class="text-base font-semibold">No posts yet</h3>
      <p class="max-w-sm text-sm text-muted-foreground">
        Ask the company brain for a post in your style, start a graphic, or upload posts you’ve
        already made.
      </p>
    </div>
  {:else}
    <div class={cn('grid gap-8', selected && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]')}>
      <ul
        class="grid content-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(11rem,1fr))]"
        aria-label="Posts"
        data-testid="social-posts"
      >
        {#each shown as post (post.id)}
          <li>
            <button
              type="button"
              class={cn(
                'flex w-full flex-col gap-2 rounded-lg border p-2 text-left transition-colors hover:bg-muted/40',
                post.id === selectedId ? 'border-foreground/60' : 'border-border',
              )}
              aria-pressed={post.id === selectedId}
              data-testid="social-card"
              onclick={() => (selectedId = post.id === selectedId ? null : post.id)}
            >
              <div
                class="flex aspect-square w-full items-center justify-center overflow-hidden rounded-md bg-muted/40"
              >
                {#if post.source === 'graphic' && post.graphic && post.format && style}
                  <div
                    class={post.format === 'story'
                      ? 'w-1/2'
                      : post.format === 'portrait'
                        ? 'w-4/5'
                        : 'w-full'}
                  >
                    <SocialGraphicView
                      setName={style.name}
                      cssVars={style.cssVars}
                      darkCssVars={style.darkCssVars}
                      format={post.format}
                      graphic={post.graphic}
                      testid="social-thumb"
                    />
                  </div>
                {:else if post.media[0]?.mime.startsWith('video/')}
                  <span class="text-xs text-muted-foreground">Video</span>
                {:else if post.media[0]?.mime === 'application/pdf'}
                  <span class="text-xs text-muted-foreground">PDF</span>
                {:else if post.media[0]}
                  <img class="size-full object-cover" src={mediaUrl(post.media[0].id)} alt="" />
                {:else}
                  <span class="text-xs text-muted-foreground">Graphic</span>
                {/if}
              </div>
              <span class="truncate text-sm font-medium">{post.title}</span>
              <span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span class="inline-flex items-center gap-1">
                  <span
                    class={cn(
                      'size-1.5 rounded-full',
                      post.status === 'posted'
                        ? 'bg-foreground/40'
                        : post.status === 'ready'
                          ? 'bg-primary'
                          : 'border border-foreground/40',
                    )}
                    aria-hidden="true"
                  ></span>
                  {SOCIAL_STATUS_LABELS[post.status]}
                </span>
                {#if post.plannedFor}<span>{day(post.plannedFor)}</span>{/if}
                {#if post.media.length > 1}<span>{post.media.length} images</span>{/if}
              </span>
              <span class="truncate text-xs text-muted-foreground"
                >{post.networks.map((n) => SOCIAL_NETWORK_LABELS[n]).join(' · ')}</span
              >
            </button>
          </li>
        {/each}
      </ul>
      {#if selected}
        {#key selected.id}
          <SocialPostEditor
            post={selected}
            {style}
            {activeLocales}
            {api}
            {pdfPages}
            onSaved={replace}
            onDeleted={(id) => {
              posts = posts.filter((p) => p.id !== id)
              selectedId = null
            }}
          />
        {/key}
      {/if}
    </div>
  {/if}
</div>

<SocialUploadDialog
  bind:open={uploadOpen}
  {api}
  onUploaded={(post) => {
    replace(post)
    selectedId = post.id
    filter = 'all'
  }}
/>
