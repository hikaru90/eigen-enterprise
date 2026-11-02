<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { docTitle } from '$lib/shell/title'

  /** Settings → Members: who belongs to the company, their roles, and invites by email. */
  let { data, form }: PageProps = $props()

  const roleLabel = (role: string) =>
    role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member'
  const feedback = (action: string) =>
    form && form.action === action
      ? 'error' in form && form.error
        ? { error: true, text: form.error }
        : { error: false, text: 'Done.' }
      : null
</script>

<svelte:head>
  <title>{docTitle('Members & invites', 'Settings')}</title>
</svelte:head>

<div>
  <header class="mb-8">
    <h2 class="text-base font-semibold tracking-tight">Members &amp; invites</h2>
    <p class="mt-1 text-sm text-foreground/60">
      The people in {data.companyName ?? 'your company'}, their roles, and invites by email.
    </p>
  </header>

  <section class="space-y-3" data-testid="members-list">
    <h3 class="text-sm font-semibold">People</h3>
    <ul class="divide-y divide-border border border-border">
      {#each data.members as m (m.id)}
        <li class="flex flex-wrap items-center justify-between gap-3 p-3" data-testid="member-row">
          <div class="min-w-0">
            <p class="truncate text-xs font-medium">{m.name || m.email}</p>
            <p class="text-muted-foreground truncate text-[11px]">{m.email}</p>
          </div>
          {#if m.role === 'owner'}
            <span class="text-xs" data-testid="member-role">Owner</span>
          {:else}
            <div class="flex items-center gap-2">
              <form method="post" action="?/setRole" use:enhance class="flex items-center gap-2">
                <input type="hidden" name="userId" value={m.id} />
                <label class="sr-only" for="role-{m.id}">Role for {m.email}</label>
                <select
                  id="role-{m.id}"
                  name="role"
                  class="border-input bg-card h-8 border px-2 text-xs"
                  value={m.role}
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                </select>
                <button
                  type="submit"
                  class="border border-border px-2 py-1 text-xs hover:border-primary">Save</button
                >
              </form>
              {#if m.id !== data.me.id}
                <form method="post" action="?/remove" use:enhance>
                  <input type="hidden" name="userId" value={m.id} />
                  <button type="submit" class="px-2 py-1 text-xs text-red-700 hover:underline"
                    >Remove</button
                  >
                </form>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#each ['setRole', 'remove'] as a (a)}
      {@const f = feedback(a)}
      {#if f}<p class="text-xs {f.error ? 'text-red-700' : 'text-muted-foreground'}">
          {f.text}
        </p>{/if}
    {/each}
  </section>

  <section class="mt-10 space-y-3" data-testid="members-invite">
    <h3 class="text-sm font-semibold">Invite someone</h3>
    <form method="post" action="?/invite" use:enhance class="flex flex-wrap items-end gap-2">
      <div class="min-w-0 flex-1 space-y-1">
        <label class="text-xs" for="invite-email">Email</label>
        <input
          id="invite-email"
          type="email"
          name="email"
          required
          class="border-input bg-card h-9 w-full border px-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div class="space-y-1">
        <label class="text-xs" for="invite-role">Role</label>
        <select id="invite-role" name="role" class="border-input bg-card h-9 border px-2 text-xs">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <button
        type="submit"
        class="h-9 bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >Send invite</button
      >
    </form>
    {#if feedback('invite')}
      {@const f = feedback('invite')!}
      <p
        class="text-xs {f.error ? 'text-red-700' : 'text-muted-foreground'}"
        data-testid="invite-feedback"
      >
        {f.error ? f.text : 'Invite sent.'}
      </p>
    {/if}
    {#if data.invites.length > 0}
      <h3 class="text-muted-foreground pt-2 text-xs font-medium">Waiting to accept</h3>
      <ul class="space-y-1" data-testid="members-pending">
        {#each data.invites as i (i.id)}
          <li class="text-xs">
            {i.email} · {roleLabel(i.role)} · expires {new Date(i.expiresAt).toLocaleDateString()}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
