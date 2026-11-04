<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { avatarUrl, isAvatarSha } from '$lib/profile/profile'
  import { docTitle } from '$lib/shell/title'

  /**
   * Settings → Members: who belongs to the company, their roles (explained in
   * plain words), invites by link, and groups (Sales, Dev …) that folders and
   * channels are shared with.
   */
  let { data, form }: PageProps = $props()

  const nameOf = (id: string) => {
    const m = data.members.find((x) => x.id === id)
    return m ? m.name || m.email : 'Former member'
  }

  const invited = $derived(
    form && form.action === 'invite' && 'inviteUrl' in form
      ? (form as unknown as { inviteUrl: string; inviteEmail: string; emailed: boolean })
      : null,
  )

  let copied = $state(false)
  async function copyInvite(url: string) {
    await navigator.clipboard.writeText(url)
    copied = true
    setTimeout(() => (copied = false), 2000)
  }

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
      The people in {data.companyName ?? 'your company'}, their roles, groups, and invites.
    </p>
  </header>

  <section class="mb-10 space-y-2" data-testid="members-roles">
    <h3 class="text-sm font-semibold">What each role can do</h3>
    <dl class="space-y-2 text-xs">
      <div>
        <dt class="font-medium">Owner</dt>
        <dd class="text-muted-foreground">
          The person who runs the company here. Can do everything, including all settings and
          billing. There is exactly one owner; nobody can remove or demote them.
        </dd>
      </div>
      <div>
        <dt class="font-medium">Admin</dt>
        <dd class="text-muted-foreground">
          Helps run the company: invites and removes people, changes roles, manages groups, and
          can open and share every channel and folder. Can't change the owner.
        </dd>
      </div>
      <div>
        <dt class="font-medium">Member</dt>
        <dd class="text-muted-foreground">
          Uses the company: sees what is shared with them, everyone in the company, or one of
          their groups. Can't change people, roles or settings.
        </dd>
      </div>
    </dl>
  </section>

  <section class="space-y-3" data-testid="members-list">
    <h3 class="text-sm font-semibold">People</h3>
    <ul class="divide-y divide-border border border-border">
      {#each data.members as m (m.id)}
        <li class="flex flex-wrap items-center justify-between gap-3 p-3" data-testid="member-row">
          <div class="flex min-w-0 items-center gap-2.5">
            <UserAvatar name={m.name || m.email} image={isAvatarSha(m.avatarSha256) ? avatarUrl(m.avatarSha256) : null} size="sm" />
            <div class="min-w-0">
              <p class="truncate text-xs font-medium">{m.name || m.email}</p>
              <p class="text-muted-foreground truncate text-[11px]">{m.email}</p>
            </div>
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
    <p class="text-muted-foreground text-xs">
      Enter their email (it becomes their account) and a role. You get a one-time link to copy.
    </p>
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
        >Create invite link</button
      >
    </form>
    {#if invited}
      {@const url = invited.inviteUrl}
      <div class="space-y-2 border border-border p-3" data-testid="invite-link">
        <p class="text-xs">
          Send this link to <strong>{invited.inviteEmail}</strong> in a message. It works once, for 7
          days. They open it, enter their name and create a passkey — no email needed.
          {#if invited.emailed}We also emailed it to them.{/if}
        </p>
        <div class="flex gap-2">
          <input
            readonly
            value={url}
            aria-label="Invite link"
            data-testid="invite-link-url"
            class="border-input bg-card h-9 min-w-0 flex-1 border px-2.5 font-mono text-[11px]"
            onfocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            class="h-9 border border-border px-3 text-xs hover:border-primary"
            onclick={() => copyInvite(url)}
            data-testid="invite-link-copy">{copied ? 'Copied' : 'Copy link'}</button
          >
        </div>
      </div>
    {:else if feedback('invite')?.error}
      <p class="text-xs text-red-700" data-testid="invite-feedback">{feedback('invite')!.text}</p>
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

  <section class="mt-10 space-y-3" data-testid="members-groups">
    <h3 class="text-sm font-semibold">Groups</h3>
    <p class="text-muted-foreground text-xs">
      Teams such as Sales or Dev. Share a folder or a channel with a group and everyone in it gets
      access; people added later get it too.
    </p>
    {#if data.groups.length > 0}
      <ul class="divide-y divide-border border border-border">
        {#each data.groups as g (g.id)}
          <li class="p-3" data-testid="group-row">
            <details>
              <summary class="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
                <span class="text-xs font-medium" data-testid="group-name">{g.name}</span>
                <span class="text-muted-foreground text-[11px]" data-testid="group-members">
                  {g.memberIds.length === 0
                    ? 'No members yet'
                    : g.memberIds.map(nameOf).join(', ')}
                </span>
              </summary>
              {#if g.description}<p class="text-muted-foreground mt-1 text-[11px]">
                  {g.description}
                </p>{/if}
              <form method="post" action="?/updateGroup" use:enhance class="mt-3 space-y-2">
                <input type="hidden" name="groupId" value={g.id} />
                <label class="block text-xs" for="group-name-{g.id}">Name</label>
                <input
                  id="group-name-{g.id}"
                  name="name"
                  value={g.name}
                  required
                  maxlength="80"
                  class="border-input bg-card h-8 w-full border px-2 text-xs"
                />
                <label class="block text-xs" for="group-desc-{g.id}">Description</label>
                <input
                  id="group-desc-{g.id}"
                  name="description"
                  value={g.description}
                  maxlength="500"
                  class="border-input bg-card h-8 w-full border px-2 text-xs"
                />
                <fieldset class="space-y-1">
                  <legend class="text-xs">Members</legend>
                  {#each data.members as m (m.id)}
                    <label class="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        name="memberIds"
                        value={m.id}
                        checked={g.memberIds.includes(m.id)}
                      />
                      {m.name || m.email}
                    </label>
                  {/each}
                </fieldset>
                <div class="flex gap-2">
                  <button
                    type="submit"
                    class="h-8 bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                    >Save group</button
                  >
                </div>
              </form>
              <form method="post" action="?/deleteGroup" use:enhance class="mt-2">
                <input type="hidden" name="groupId" value={g.id} />
                <button type="submit" class="text-xs text-red-700 hover:underline"
                  >Delete group</button
                >
              </form>
            </details>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-muted-foreground text-xs" data-testid="groups-empty">No groups yet.</p>
    {/if}

    <form
      method="post"
      action="?/createGroup"
      use:enhance
      class="space-y-2 border border-border p-3"
      data-testid="group-create"
    >
      <p class="text-xs font-medium">New group</p>
      <div class="flex flex-wrap gap-2">
        <div class="min-w-0 flex-1 space-y-1">
          <label class="text-xs" for="new-group-name">Name</label>
          <input
            id="new-group-name"
            name="name"
            required
            maxlength="80"
            placeholder="Sales"
            class="border-input bg-card h-9 w-full border px-2.5 text-xs"
          />
        </div>
        <div class="min-w-0 flex-[2] space-y-1">
          <label class="text-xs" for="new-group-desc">Description (optional)</label>
          <input
            id="new-group-desc"
            name="description"
            maxlength="500"
            class="border-input bg-card h-9 w-full border px-2.5 text-xs"
          />
        </div>
      </div>
      <fieldset class="space-y-1">
        <legend class="text-xs">Members</legend>
        {#each data.members as m (m.id)}
          <label class="flex items-center gap-2 text-xs">
            <input type="checkbox" name="memberIds" value={m.id} />
            {m.name || m.email}
          </label>
        {/each}
      </fieldset>
      <button
        type="submit"
        class="h-9 bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >Create group</button
      >
    </form>
    {#each ['createGroup', 'updateGroup', 'deleteGroup'] as a (a)}
      {@const f = feedback(a)}
      {#if f}<p
          class="text-xs {f.error ? 'text-red-700' : 'text-muted-foreground'}"
          data-testid="group-feedback"
        >
          {f.text}
        </p>{/if}
    {/each}
  </section>
</div>
