<script lang="ts">
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import AiMark from '$lib/coworkers/ai-mark.svelte'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * One row of Settings → Members: picture, name and address, and the role
   * controls (members.set_role / members.remove). An AI co-worker
   * (plan/phase-ai-coworkers.md C5) carries the AI mark and is managed in
   * Settings → Co-workers instead: it is always a member and is removed there,
   * so no role or remove control is offered for it (the tools refuse it anyway).
   */
  let {
    member: m_,
    meId,
  }: {
    member: { id: string; name: string; email: string; role: 'owner' | 'admin' | 'member'; kind: 'human' | 'coworker'; image: string | null }
    meId: string
  } = $props()

  const label = $derived(m_.name || m_.email)
</script>

<li class="flex flex-wrap items-center justify-between gap-3 p-3" data-testid="member-row" data-kind={m_.kind}>
  <div class="flex min-w-0 items-center gap-2.5">
    <UserAvatar name={label} image={m_.image} size="sm" />
    <div class="min-w-0">
      <p class="flex items-center gap-1.5 truncate text-xs font-medium">
        <span class="truncate">{label}</span>
        {#if m_.kind === 'coworker'}<AiMark />{/if}
      </p>
      {#if m_.kind === 'human'}<p class="truncate text-xs text-muted-foreground">{m_.email}</p>{/if}
    </div>
  </div>
  {#if m_.kind === 'coworker'}
    <a
      href={resolve('/settings/coworkers')}
      class="rounded-sm text-xs underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="member-coworker-link">{m.members_coworker_managed()}</a
    >
  {:else if m_.role === 'owner'}
    <span class="text-xs" data-testid="member-role">Owner</span>
  {:else}
    <div class="flex items-center gap-2">
      <form method="post" action="?/setRole" use:enhance class="flex items-center gap-2">
        <input type="hidden" name="userId" value={m_.id} />
        <label class="sr-only" for="role-{m_.id}">Role for {m_.email}</label>
        <select id="role-{m_.id}" name="role" class="h-8 border border-input bg-card px-2 text-xs" value={m_.role} data-testid="member-role-select">
          <option value="admin">Admin</option>
          <option value="member">Member</option>
        </select>
        <button type="submit" class="border border-border px-2 py-1 text-xs hover:border-primary">Save</button>
      </form>
      {#if m_.id !== meId}
        <form method="post" action="?/remove" use:enhance>
          <input type="hidden" name="userId" value={m_.id} />
          <button type="submit" class="px-2 py-1 text-xs text-red-700 hover:underline" data-testid="member-remove">Remove</button>
        </form>
      {/if}
    </div>
  {/if}
</li>
