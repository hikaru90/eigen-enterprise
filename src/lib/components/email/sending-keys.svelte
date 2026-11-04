<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import CopyButton from './copy-button.svelte'

  /**
   * Sending keys for the API page: one button makes a key that can only send
   * mail (MCP off), shows it once, and hands it to the parent so the curl
   * example fills in. Uses the one key store (/api/keys).
   */
  type Key = { id: string; name: string; keyPrefix: string; mailSend: boolean; lastUsedAt: string | null; createdAt: string }

  let { canManage, onCreated }: { canManage: boolean; onCreated: (key: string | null) => void } = $props()

  let keys = $state<Key[]>([])
  let loaded = $state(false)
  let error = $state<string | null>(null)
  let name = $state('')
  let creating = $state(false)
  let newKey = $state<string | null>(null)

  async function load() {
    const res = await fetch('/api/keys', { credentials: 'include' })
    if (!res.ok) {
      error = `Could not load the keys (HTTP ${res.status}).`
      return
    }
    keys = ((await res.json()) as { keys: Key[] }).keys.filter((k) => k.mailSend)
    loaded = true
  }

  onMount(() => {
    void load()
  })

  async function create() {
    creating = true
    error = null
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || `Sending key ${new Date().toLocaleDateString()}`, mailSend: true, mcp: false }),
      })
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`)
      newKey = ((await res.json()) as { key: string }).key
      onCreated(newKey)
      name = ''
      await load()
    } catch (e) {
      error = `Could not create the key: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      creating = false
    }
  }

  async function revoke(key: Key) {
    if (!confirm(`Revoke “${key.name}”? Anything sending with it stops working at once.`)) return
    const res = await fetch(`/api/keys/${key.id}`, { method: 'DELETE', credentials: 'include' })
    if (!res.ok) {
      error = `Could not revoke “${key.name}” (HTTP ${res.status}).`
      return
    }
    keys = keys.filter((k) => k.id !== key.id)
  }

  const when = (d: string | null) => (d ? new Date(d).toLocaleDateString() : 'never')
</script>

<div data-testid="sending-keys">
  {#if newKey}
    <div class="rounded-lg border border-primary/40 px-4 py-3" data-testid="sending-key-new">
      <p class="text-sm font-medium">Your new sending key</p>
      <div class="mt-2 flex items-start gap-1">
        <code class="min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-xs break-all" data-testid="sending-key-value">{newKey}</code>
        <CopyButton value={newKey} label="Copy the key" />
      </div>
      <p class="mt-2 text-xs text-muted-foreground">
        Copy it now and keep it secret — it is shown only this once. Store it in your app as an environment variable (for example
        <code class="font-mono">EE_API_KEY</code>), never in your code. The example below already uses it.
      </p>
      <Button
        class="mt-3"
        size="sm"
        variant="outline"
        onclick={() => {
          newKey = null
          onCreated(null)
        }}>I saved it</Button
      >
    </div>
  {:else if canManage}
    <div class="flex flex-wrap items-end gap-3">
      <div class="grid min-w-56 flex-1 gap-1.5 sm:max-w-xs">
        <Label for="sending-key-name">Name (which app uses it — optional)</Label>
        <Input id="sending-key-name" placeholder="e.g. Online shop" bind:value={name} disabled={creating} />
      </div>
      <Button onclick={() => void create()} disabled={creating} data-testid="create-sending-key">
        {creating ? 'Creating…' : 'Create sending key'}
      </Button>
    </div>
  {:else}
    <p class="text-sm text-muted-foreground">The owner or an admin creates sending keys.</p>
  {/if}

  <div class="mt-5">
    <h3 class="text-sm font-medium">Keys that can send</h3>
    {#if !loaded && !error}
      <p class="mt-2 text-sm text-muted-foreground">Loading…</p>
    {:else if keys.length === 0}
      <p class="mt-2 text-sm text-muted-foreground" data-testid="sending-keys-empty">None yet.</p>
    {:else}
      <ul class="mt-2 divide-y divide-border rounded-lg border border-border">
        {#each keys as key (key.id)}
          <li class="flex flex-wrap items-center gap-3 px-4 py-2.5" data-testid="sending-key-row">
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{key.name}</span>
              <span class="block text-xs text-muted-foreground">
                <code class="font-mono">{key.keyPrefix}…</code> · created {when(key.createdAt)} · last used {when(key.lastUsedAt)}
              </span>
            </span>
            {#if canManage}<Button size="sm" variant="outline" onclick={() => void revoke(key)}>Revoke</Button>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if error}<p class="mt-2 text-sm text-destructive" role="alert">{error}</p>{/if}
  </div>
</div>
