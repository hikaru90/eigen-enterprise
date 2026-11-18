<script lang="ts">
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import {
    NETWORK_CAPTION_LIMITS,
    SOCIAL_FORMATS,
    SOCIAL_NETWORK_LABELS,
    SOCIAL_NETWORKS,
    SOCIAL_STATUS_LABELS,
    SOCIAL_STATUSES,
    socialFormat,
    type SocialCaptions,
    type SocialFormatId,
    type SocialGraphic,
    type SocialNetwork,
    type SocialPost,
    type SocialPostStatus,
  } from '../../../../../modules/brand/social/types'
  import { mediaUrl, type CaptionSuggestions, type SocialApi } from './social-api'
  import { fileStem, renderGraphicPng, saveBlob } from './social-export'
  import SocialGraphicView from './social-graphic.svelte'

  /**
   * One social post, editable: its media (the branded graphic drawn in the
   * active style, or the uploaded files), downloads, title, networks, status,
   * planned day and one caption per network — with "Suggest captions" asking
   * the brand voice for three variants per network to pick from. The parent
   * keys this on the post, so the fields start from the post once.
   */
  type Style = { name: string; cssVars: Record<string, string>; darkCssVars: Record<string, string> | null }

  let {
    post,
    style,
    activeLocales,
    api,
    onSaved,
    onDeleted,
  }: {
    post: SocialPost
    style: Style | null
    activeLocales: string[]
    api: SocialApi
    onSaved: (post: SocialPost) => void
    onDeleted: (postId: string) => void
  } = $props()

  // svelte-ignore state_referenced_locally
  let title = $state(post.title)
  // svelte-ignore state_referenced_locally
  let networks = $state<SocialNetwork[]>([...post.networks])
  // svelte-ignore state_referenced_locally
  let captions = $state<SocialCaptions>({ ...post.captions })
  // svelte-ignore state_referenced_locally
  let status = $state<SocialPostStatus>(post.status)
  // svelte-ignore state_referenced_locally
  let plannedFor = $state(post.plannedFor ?? '')
  // svelte-ignore state_referenced_locally
  let format = $state<SocialFormatId>(post.format ?? 'square')
  // svelte-ignore state_referenced_locally
  let graphic = $state<SocialGraphic>(post.graphic ? { ...post.graphic } : { headline: '', body: '', cta: '', mode: 'light' })

  let saving = $state(false)
  let saved = $state(false)
  let error = $state<string | null>(null)
  let brief = $state('')
  // svelte-ignore state_referenced_locally
  let locale = $state(activeLocales[0] ?? '')
  let suggesting = $state(false)
  let suggestions = $state<CaptionSuggestions | null>(null)
  let suggestError = $state<string | null>(null)
  let copied = $state<SocialNetwork | null>(null)
  let confirmDelete = $state(false)
  let graphicRoot = $state<HTMLElement | null>(null)

  const isGraphic = $derived(post.source === 'graphic')
  const isVideo = $derived(post.media.some((m) => m.mime.startsWith('video/')))

  function toggleNetwork(n: SocialNetwork) {
    networks = networks.includes(n) ? networks.filter((x) => x !== n) : SOCIAL_NETWORKS.filter((x) => x === n || networks.includes(x))
    saved = false
  }

  function setCaption(n: SocialNetwork, text: string) {
    captions = { ...captions, [n]: text }
    saved = false
  }

  async function save() {
    saving = true
    error = null
    try {
      const kept: SocialCaptions = {}
      for (const n of networks) {
        const c = captions[n]?.trim()
        if (c) kept[n] = c
      }
      const updated = await api.update(post.id, {
        title,
        networks,
        captions: kept,
        status,
        plannedFor: plannedFor || null,
        ...(isGraphic ? { format, graphic } : {}),
      })
      saved = true
      onSaved(updated)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      saving = false
    }
  }

  async function suggest() {
    suggesting = true
    suggestError = null
    suggestions = null
    try {
      suggestions = await api.suggestCaptions(post.id, {
        networks: post.networks.filter((n) => networks.includes(n)),
        ...(activeLocales.length > 1 && locale ? { locale } : {}),
        ...(brief.trim() ? { brief: brief.trim() } : {}),
      })
    } catch (err) {
      suggestError = err instanceof Error ? err.message : String(err)
    } finally {
      suggesting = false
    }
  }

  async function copy(n: SocialNetwork) {
    await navigator.clipboard.writeText(captions[n] ?? '')
    copied = n
    setTimeout(() => {
      if (copied === n) copied = null
    }, 1500)
  }

  async function downloadGraphic() {
    error = null
    try {
      if (!graphicRoot) throw new Error('The graphic is not on the page.')
      const f = socialFormat(format)
      saveBlob(await renderGraphicPng(graphicRoot, f), `${fileStem(title)}-${f.width}x${f.height}.png`)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  async function remove() {
    error = null
    try {
      await api.remove(post.id)
      onDeleted(post.id)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }
</script>

<section class="flex flex-col gap-6" data-testid="social-editor" aria-label="Post {post.title}">
  <div class="flex flex-col gap-3">
    {#if isGraphic}
      {#if style}
        <div class={format === 'story' ? 'mx-auto w-full max-w-64' : format === 'portrait' ? 'mx-auto w-full max-w-80' : 'w-full'}>
          <SocialGraphicView
            setName={style.name}
            cssVars={style.cssVars}
            darkCssVars={style.darkCssVars}
            {format}
            {graphic}
            bind:root={graphicRoot}
          />
        </div>
        <Button variant="outline" size="sm" class="w-fit" onclick={downloadGraphic}>
          Download PNG · {socialFormat(format).width} × {socialFormat(format).height}
        </Button>
      {:else}
        <p class="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-foreground/55">
          This graphic is drawn from your active style. <a class="underline" href={resolve('/brand')}>Choose a style</a> to see it.
        </p>
      {/if}
    {:else if isVideo}
      <!-- The person’s own uploaded clip: its text is the post caption. -->
      <!-- svelte-ignore a11y_media_has_caption -->
      <video class="w-full rounded-lg border border-border" src={mediaUrl(post.media[0].id)} controls preload="metadata"></video>
    {:else}
      <img class="w-full rounded-lg border border-border object-contain" src={mediaUrl(post.media[0].id)} alt={post.title} />
      {#if post.media.length > 1}
        <ul class="flex gap-2 overflow-x-auto" aria-label="Carousel">
          {#each post.media as m (m.id)}
            <li class="shrink-0"><img class="size-16 rounded-md border border-border object-cover" src={mediaUrl(m.id)} alt={m.name} /></li>
          {/each}
        </ul>
      {/if}
    {/if}
    {#if !isGraphic}
      <ul class="flex flex-wrap gap-2" aria-label="Files">
        {#each post.media as m (m.id)}
          <li>
            <Button variant="outline" size="sm" href={mediaUrl(m.id, true)} download={m.name}>Download {m.name}</Button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="flex flex-col gap-1.5">
    <Label for="social-title">Title</Label>
    <Input id="social-title" bind:value={title} oninput={() => (saved = false)} />
  </div>

  {#if isGraphic}
    <fieldset class="flex flex-col gap-3">
      <legend class="mb-2 text-sm font-medium">Graphic</legend>
      <div class="flex flex-wrap gap-2" role="group" aria-label="Format">
        {#each SOCIAL_FORMATS as f (f.id)}
          <Button size="sm" variant={format === f.id ? 'secondary' : 'ghost'} aria-pressed={format === f.id} onclick={() => ((format = f.id), (saved = false))}>
            {f.label} · {f.ratio}
          </Button>
        {/each}
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="social-headline">Headline</Label>
        <Input id="social-headline" bind:value={graphic.headline} oninput={() => (saved = false)} />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="social-body">Text</Label>
        <Textarea id="social-body" rows={2} bind:value={graphic.body} oninput={() => (saved = false)} />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="social-cta">Button</Label>
        <Input id="social-cta" bind:value={graphic.cta} oninput={() => (saved = false)} />
      </div>
      <div class="inline-flex w-fit rounded-md border border-border p-0.5" role="group" aria-label="Graphic theme">
        {#each ['light', 'dark'] as const as m (m)}
          <Button size="sm" variant={graphic.mode === m ? 'default' : 'ghost'} aria-pressed={graphic.mode === m} onclick={() => ((graphic.mode = m), (saved = false))}>
            {m === 'light' ? 'Light' : 'Dark'}
          </Button>
        {/each}
      </div>
    </fieldset>
  {/if}

  <div class="flex flex-col gap-2">
    <span class="text-sm font-medium" id="social-networks-label">Networks</span>
    <div class="flex flex-wrap gap-2" role="group" aria-labelledby="social-networks-label">
      {#each SOCIAL_NETWORKS as n (n)}
        <Button size="sm" variant={networks.includes(n) ? 'secondary' : 'ghost'} aria-pressed={networks.includes(n)} onclick={() => toggleNetwork(n)}>
          {SOCIAL_NETWORK_LABELS[n]}
        </Button>
      {/each}
    </div>
  </div>

  <div class="flex flex-wrap items-end gap-4">
    <div class="flex flex-col gap-2">
      <span class="text-sm font-medium" id="social-status-label">Status</span>
      <div class="inline-flex w-fit rounded-md border border-border p-0.5" role="group" aria-labelledby="social-status-label">
        {#each SOCIAL_STATUSES as s (s)}
          <Button size="sm" variant={status === s ? 'default' : 'ghost'} aria-pressed={status === s} onclick={() => ((status = s), (saved = false))}>
            {SOCIAL_STATUS_LABELS[s]}
          </Button>
        {/each}
      </div>
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="social-planned">Planned for</Label>
      <Input id="social-planned" type="date" class="w-44" bind:value={plannedFor} oninput={() => (saved = false)} />
    </div>
  </div>

  <div class="flex flex-col gap-4">
    <h3 class="text-sm font-medium">Captions</h3>
    {#if networks.length === 0}
      <p class="text-sm text-foreground/55">Pick a network to write its caption.</p>
    {/if}
    {#each networks as n (n)}
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between gap-2">
          <Label for="caption-{n}">{SOCIAL_NETWORK_LABELS[n]}</Label>
          <span class="flex items-center gap-2">
            <span class="text-xs text-foreground/55 tabular-nums">{(captions[n] ?? '').length} / {NETWORK_CAPTION_LIMITS[n]}</span>
            <Button size="sm" variant="ghost" onclick={() => copy(n)} disabled={!captions[n]}>
              {copied === n ? 'Copied' : 'Copy'}
            </Button>
          </span>
        </div>
        <Textarea
          id="caption-{n}"
          rows={4}
          maxlength={NETWORK_CAPTION_LIMITS[n]}
          value={captions[n] ?? ''}
          oninput={(e) => setCaption(n, e.currentTarget.value)}
        />
      </div>
    {/each}

    {#if post.networks.some((n) => networks.includes(n))}
      <div class="flex flex-col gap-3 rounded-lg border border-border p-4">
        <div class="flex flex-col gap-1.5">
          <Label for="social-brief">What should the captions say? <span class="font-normal text-foreground/55">(optional)</span></Label>
          <Input id="social-brief" bind:value={brief} placeholder="e.g. mention the launch on Friday" />
        </div>
        {#if activeLocales.length > 1}
          <div class="flex flex-col gap-1.5">
            <Label for="social-locale">Language</Label>
            <select id="social-locale" class="h-9 w-fit rounded-md border border-border bg-background px-2 text-sm" bind:value={locale}>
              {#each activeLocales as l (l)}<option value={l}>{l}</option>{/each}
            </select>
          </div>
        {/if}
        <Button variant="outline" size="sm" class="w-fit" onclick={suggest} disabled={suggesting}>
          {suggesting ? 'Suggesting…' : 'Suggest captions'}
        </Button>
        {#if suggestError}
          <p class="text-sm text-destructive" role="alert">{suggestError}</p>
        {/if}
        {#if suggestions}
          {#if !suggestions.voice}
            <p class="text-xs text-foreground/55">No brand voice is active yet, so these follow the post only.</p>
          {/if}
          <div class="flex flex-col gap-4" data-testid="caption-suggestions">
            {#each Object.entries(suggestions.captions) as [network, variants] (network)}
              <div class="flex flex-col gap-2">
                <span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">{SOCIAL_NETWORK_LABELS[network as SocialNetwork]}</span>
                <ul class="flex flex-col gap-2">
                  {#each variants ?? [] as text, i (i)}
                    <li class="flex items-start justify-between gap-3 rounded-md bg-muted/50 p-3">
                      <p class="text-sm whitespace-pre-line">{text}</p>
                      <Button size="sm" variant="ghost" onclick={() => setCaption(network as SocialNetwork, text)}>Use</Button>
                    </li>
                  {/each}
                </ul>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {:else if networks.length > 0}
      <p class="text-xs text-foreground/55">Save the post to get caption suggestions for the networks you added.</p>
    {/if}
  </div>

  {#if error}
    <p class="text-sm text-destructive" role="alert">{error}</p>
  {/if}

  <div class="flex flex-wrap items-center gap-3 border-t border-border pt-4">
    <Button onclick={save} disabled={saving || networks.length === 0 || !title.trim()}>{saving ? 'Saving…' : 'Save'}</Button>
    {#if saved}<span class="text-sm text-foreground/55" role="status">Saved</span>{/if}
    <span class="flex-1"></span>
    {#if confirmDelete}
      <span class="text-sm text-foreground/55">Delete this post{post.media.length ? ' and its files' : ''}?</span>
      <Button variant="destructive" size="sm" onclick={remove}>Delete</Button>
      <Button variant="ghost" size="sm" onclick={() => (confirmDelete = false)}>Keep</Button>
    {:else}
      <Button variant="ghost" size="sm" onclick={() => (confirmDelete = true)}>Delete…</Button>
    {/if}
  </div>
</section>
