<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import CopyIcon from '@lucide/svelte/icons/copy'
  import { onMount } from 'svelte'
  import { base } from '$app/paths'
  import { page } from '$app/stores'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  /**
   * Mail-sending API keys on the Email module page. Uses the one key store
   * (/api/keys); a key made here is mail-only: "Can send mail" on, MCP off.
   */
  type Key = {
    id: string
    name: string
    keyPrefix: string
    mailSend: boolean
    lastUsedAt: string | null
    createdAt: string
  }

  let keys = $state<Key[]>([])
  let loaded = $state(false)
  let error = $state<string | null>(null)
  let name = $state('')
  let creating = $state(false)
  let newKey = $state<string | null>(null)
  let copied = $state<'key' | 'curl' | null>(null)

  const endpoint = $derived(`${$page.url.origin}${base}/api/mail/send`)
  const curl = $derived(
    `curl -sS -X POST ${endpoint} \\\n` +
      `  -H "Authorization: Bearer $EIGEN_API_KEY" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{"to":"someone@example.com","subject":"Hello","text":"Hi there","idempotencyKey":"hello-1"}'`,
  )

  async function load() {
    const res = await fetch(`${base}/api/keys`, { credentials: 'include' })
    if (!res.ok) {
      error = `Could not load keys (${res.status})`
      return
    }
    keys = (await res.json()).keys
    loaded = true
  }

  onMount(() => {
    void load()
  })

  async function create() {
    const trimmed = name.trim()
    if (!trimmed) {
      error = 'Give the key a name, for example the agent that will use it.'
      return
    }
    creating = true
    error = null
    try {
      const res = await fetch(`${base}/api/keys`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, mailSend: true, mcp: false }),
      })
      if (!res.ok) throw new Error(await res.text())
      newKey = (await res.json()).key
      name = ''
      await load()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      creating = false
    }
  }

  async function setMailSend(key: Key, mailSend: boolean) {
    error = null
    const res = await fetch(`${base}/api/keys/${key.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mailSend }),
    })
    if (!res.ok) {
      error = `Could not change "${key.name}" (${res.status})`
      return
    }
    key.mailSend = mailSend
  }

  async function revoke(key: Key) {
    if (!confirm(`Revoke "${key.name}"? Anything using it stops working.`)) return
    const res = await fetch(`${base}/api/keys/${key.id}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    if (!res.ok) {
      error = `Could not revoke "${key.name}" (${res.status})`
      return
    }
    keys = keys.filter((k) => k.id !== key.id)
  }

  async function copy(what: 'key' | 'curl', text: string) {
    await navigator.clipboard.writeText(text)
    copied = what
    setTimeout(() => (copied = null), 2000)
  }

  function when(d: string | null): string {
    return d ? new Date(d).toLocaleDateString() : 'Never'
  }
</script>

<div class="mt-6 space-y-4" data-testid="mail-keys-panel">
  <div class="rounded-lg border border-border px-4 py-3">
    <h3 class="text-sm font-medium">How to send mail</h3>
    <p class="mt-1 text-xs text-foreground/60">
      POST to <code class="font-mono">{endpoint}</code> with a key that can send mail. Mail goes out
      at once (no approval). Reuse the same <code class="font-mono">idempotencyKey</code> when you retry.
    </p>
    <div class="relative mt-2">
      <pre
        class="overflow-x-auto rounded-md bg-foreground/5 px-3 py-2 pr-9 font-mono text-[11px] leading-relaxed">{curl}</pre>
      <button
        type="button"
        class="absolute top-1.5 right-1.5 rounded-sm p-1 text-foreground/50 hover:bg-foreground/10"
        onclick={() => void copy('curl', curl)}
        aria-label="Copy curl example"
      >
        {#if copied === 'curl'}<Check class="size-4" />{:else}<CopyIcon class="size-4" />{/if}
      </button>
    </div>
  </div>

  <div class="rounded-lg border border-border px-4 py-3">
    <h3 class="text-sm font-medium">Create a key that can send mail</h3>
    {#if newKey}
      <div class="mt-2 space-y-1.5" data-testid="mail-key-new">
        <div class="relative">
          <code class="block rounded-md bg-foreground/5 px-3 py-2 pr-9 font-mono text-xs break-all"
            >{newKey}</code
          >
          <button
            type="button"
            class="absolute top-1.5 right-1.5 rounded-sm p-1 text-foreground/50 hover:bg-foreground/10"
            onclick={() => void copy('key', newKey!)}
            aria-label="Copy key"
          >
            {#if copied === 'key'}<Check class="size-4" />{:else}<CopyIcon class="size-4" />{/if}
          </button>
        </div>
        <p class="text-xs text-amber-600 dark:text-amber-400">
          Copy it now. This key will not be shown again.
        </p>
        <Button size="sm" variant="outline" onclick={() => (newKey = null)}>Done</Button>
      </div>
    {:else}
      <div class="mt-2 flex items-end gap-2">
        <div class="min-w-0 flex-1 space-y-1">
          <Label for="mail-key-name" class="text-xs">Key name</Label>
          <Input
            id="mail-key-name"
            class="h-8 text-xs"
            placeholder="e.g. newsletter-agent"
            bind:value={name}
            disabled={creating}
          />
        </div>
        <Button size="sm" onclick={() => void create()} disabled={creating}>
          {creating ? 'Creating…' : 'Create key'}
        </Button>
      </div>
    {/if}
  </div>

  <div class="rounded-lg border border-border">
    {#if !loaded}
      <p class="px-4 py-3 text-xs text-foreground/55">Loading keys…</p>
    {:else if keys.length === 0}
      <p class="px-4 py-3 text-xs text-foreground/55">No API keys yet.</p>
    {:else}
      <ul class="divide-y divide-border">
        {#each keys as key (key.id)}
          <li class="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{key.name}</span>
              <span class="block text-[11px] text-foreground/55">
                Created {when(key.createdAt)} · Last used {when(key.lastUsedAt)}
              </span>
            </span>
            <label class="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={key.mailSend}
                onchange={(e) => void setMailSend(key, e.currentTarget.checked)}
              />
              Can send mail
            </label>
            <Button size="sm" variant="outline" onclick={() => void revoke(key)}>Revoke</Button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if error}<p class="text-xs text-destructive">{error}</p>{/if}
</div>
