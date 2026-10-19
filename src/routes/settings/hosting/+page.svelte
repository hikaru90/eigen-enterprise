<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'

  /**
   * Settings → Hosting: this server's domains, apps and GitHub connection
   * (plan/phase-substrate.md). Everything shown is read from ee; every button
   * is a kernel tool call made as the signed-in human.
   */

  let { data, form }: PageProps = $props()

  let githubOrg = $state('')
  const githubAction = $derived(
    githubOrg.trim()
      ? `https://github.com/organizations/${encodeURIComponent(githubOrg.trim())}/settings/apps/new?state=${data.githubState}`
      : `https://github.com/settings/apps/new?state=${data.githubState}`,
  )

  const managed = $derived(data.status.managed ? data.status : null)
  const apps = $derived(managed ? managed.workloads.filter((w) => w.tier === 'app') : [])
  const linkFor = (name: string) => data.github.links.find((l) => l.workload === name)
  const roleOf = (host: string) => {
    if (!managed) return ''
    if (host === managed.settings.consoleHost) return 'console'
    if (host === managed.settings.publicHost) return 'public website'
    return 'app'
  }
  const message = (action: string) =>
    form && 'action' in form && form.action === action
      ? 'error' in form && form.error
        ? { kind: 'error' as const, text: form.error }
        : 'reconcileError' in form && form.reconcileError
          ? { kind: 'error' as const, text: `Saved, but the server could not apply it: ${form.reconcileError}` }
          : { kind: 'ok' as const, text: 'Done.' }
      : null
</script>

<svelte:head>
  <title>Hosting · Eigen Enterprise</title>
</svelte:head>

{#snippet feedback(action: string)}
  {@const m = message(action)}
  {#if m}
    <p
      class="mt-2 text-xs {m.kind === 'error' ? 'text-red-700' : 'text-muted-foreground'}"
      data-testid="hosting-feedback-{action}"
    >
      {m.text}
    </p>
  {/if}
{/snippet}

<div class="mx-auto w-full max-w-2xl px-4 py-10">
  <header class="mb-8">
    <p class="text-muted-foreground text-[11px] font-medium tracking-[0.25em] uppercase">
      Eigen Enterprise
    </p>
    <h1 class="mt-1 text-xl font-medium tracking-tight">Hosting</h1>
    <p class="text-muted-foreground mt-2 text-xs">
      Your domains and apps, running on your own server. Every change is a commit in your company
      repo; a release only goes live after it passes its health check.
    </p>
  </header>

  {#if !data.status.managed}
    <p class="border-black/15 border px-4 py-3 text-sm" data-testid="hosting-unmanaged">
      {data.status.reason}. Install eigenEnterprise on a server with <code>ee</code> to manage
      domains and apps here.
    </p>
  {:else if managed}
    <main class="space-y-10">
      {#if managed.lastReconcileError}
        <p class="border border-red-700/40 px-4 py-3 text-xs text-red-700" data-testid="hosting-reconcile-error">
          {managed.lastReconcileError}
        </p>
      {/if}

      <section class="space-y-3" data-testid="hosting-domains">
        <h2 class="text-sm font-semibold">Domains</h2>
        <ul class="border-black/15 divide-y divide-black/10 border">
          {#each managed.routes as route (route.host)}
            <li class="flex items-center justify-between gap-4 px-4 py-2.5">
              <div>
                <a class="text-sm underline-offset-2 hover:underline" href="https://{route.host}">{route.host}</a>
                <p class="text-muted-foreground mt-0.5 text-xs">
                  {roleOf(route.host)}{route.workload !== 'os' ? ` · ${route.workload}` : ''}
                </p>
              </div>
              {#if route.host !== managed.settings.consoleHost}
                <form method="POST" action="?/removeDomain" use:enhance>
                  <input type="hidden" name="host" value={route.host} />
                  <button class="text-muted-foreground text-xs hover:underline">Remove</button>
                </form>
              {/if}
            </li>
          {/each}
        </ul>
        <form method="POST" action="?/addDomain" use:enhance class="flex flex-wrap items-end gap-2">
          <label class="flex-1 text-xs">
            Domain
            <input
              name="host"
              required
              placeholder="kindred.digital"
              class="border-black/20 mt-1 block w-full border px-2 py-1.5 text-sm"
            />
          </label>
          <label class="text-xs">
            Serves
            <select name="role" class="border-black/20 mt-1 block border px-2 py-1.5 text-sm">
              <option value="public">Public website</option>
              <option value="console">This app (console)</option>
              {#if apps.length > 0}<option value="app">An app</option>{/if}
            </select>
          </label>
          {#if apps.length > 0}
            <label class="text-xs">
              App
              <select name="workload" class="border-black/20 mt-1 block border px-2 py-1.5 text-sm">
                <option value="os">—</option>
                {#each apps as app (app.name)}<option value={app.name}>{app.name}</option>{/each}
              </select>
            </label>
          {/if}
          <button class="border-black/80 border px-3 py-1.5 text-sm">Add</button>
        </form>
        <p class="text-muted-foreground text-xs">
          Point the domain's DNS (an A record) at this server first; the certificate is requested
          automatically.
        </p>
        {@render feedback('addDomain')}
        {@render feedback('removeDomain')}
      </section>

      <section class="space-y-3" data-testid="hosting-github">
        <h2 class="text-sm font-semibold">GitHub</h2>
        {#if !data.github.connection}
          <form method="POST" action={githubAction} class="flex flex-wrap items-end gap-2">
            <input type="hidden" name="manifest" value={data.githubManifest} />
            <label class="flex-1 text-xs">
              Organization (leave empty for your personal account)
              <input bind:value={githubOrg} class="border-black/20 mt-1 block w-full border px-2 py-1.5 text-sm" />
            </label>
            <button class="border-black/80 border px-3 py-1.5 text-sm" data-testid="hosting-github-connect">
              Connect GitHub
            </button>
          </form>
          <p class="text-muted-foreground text-xs">
            Creates a private GitHub App for your company that can read the repositories you choose.
          </p>
        {:else if !data.github.connection.installationId}
          <p class="text-sm">
            The app <strong>{data.github.connection.appSlug}</strong> exists.
            <a class="underline" rel="external" href="{data.github.connection.htmlUrl}/installations/new">Install it on your repositories</a>.
          </p>
        {:else}
          <p class="text-muted-foreground text-xs">
            Connected as <a class="underline" rel="external" href={data.github.connection.htmlUrl}>{data.github.connection.appSlug}</a>.
          </p>
        {/if}
      </section>

      <section class="space-y-3" data-testid="hosting-apps">
        <h2 class="text-sm font-semibold">Apps</h2>
        {#if apps.length > 0}
          <ul class="border-black/15 divide-y divide-black/10 border">
            {#each apps as app (app.name)}
              {@const link = linkFor(app.name)}
              <li class="space-y-1 px-4 py-2.5">
                <div class="flex items-center justify-between gap-4">
                  <p class="text-sm">{app.name}</p>
                  <div class="flex gap-3">
                    <form method="POST" action="?/deployApp" use:enhance>
                      <input type="hidden" name="name" value={app.name} />
                      <button class="text-xs hover:underline">Deploy latest</button>
                    </form>
                    <form method="POST" action="?/removeApp" use:enhance>
                      <input type="hidden" name="name" value={app.name} />
                      <button class="text-muted-foreground text-xs hover:underline">Remove</button>
                    </form>
                  </div>
                </div>
                <p class="text-muted-foreground text-xs">
                  {link ? `${link.repoFullName} · ${link.ref}${link.autoDeploy ? ' · deploys on push' : ''}` : 'not linked'}
                  · {app.live ? `live: ${app.live.release}` : 'not live'}
                </p>
                {#if app.lastError}<p class="text-xs text-red-700">{app.lastError}</p>{/if}
                {#if app.declaredSecrets.some((s) => !app.secrets.includes(s))}
                  <p class="text-xs text-red-700">
                    Missing secrets: {app.declaredSecrets.filter((s) => !app.secrets.includes(s)).join(', ')}
                  </p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if data.github.connection?.installationId}
          <form method="POST" action="?/createApp" use:enhance class="flex flex-wrap items-end gap-2">
            <label class="text-xs">
              Repository
              <select name="repo" required class="border-black/20 mt-1 block border px-2 py-1.5 text-sm">
                {#each data.repos as repo (repo.fullName)}<option value={repo.fullName}>{repo.fullName}</option>{/each}
              </select>
            </label>
            <label class="flex-1 text-xs">
              App name
              <input name="name" required pattern="[a-z][a-z0-9-]{'{'}1,30}" placeholder="kindred-app" class="border-black/20 mt-1 block w-full border px-2 py-1.5 text-sm" />
            </label>
            <label class="flex items-center gap-1 text-xs">
              <input type="checkbox" name="autoDeploy" /> Deploy on push
            </label>
            <button class="border-black/80 border px-3 py-1.5 text-sm">Deploy</button>
          </form>
          {#if data.reposError}<p class="text-xs text-red-700">{data.reposError}</p>{/if}
          <p class="text-muted-foreground text-xs">
            The repository needs an <code>ee.json</code> saying how it builds and runs. The first
            build can take a few minutes.
          </p>
        {:else}
          <p class="text-muted-foreground text-xs">Connect GitHub to deploy your repositories here.</p>
        {/if}
        {@render feedback('createApp')}
        {@render feedback('deployApp')}
        {@render feedback('removeApp')}
      </section>

      {#if apps.length > 0}
        <section class="space-y-3" data-testid="hosting-secrets">
          <h2 class="text-sm font-semibold">App secrets</h2>
          <form method="POST" action="?/setSecret" use:enhance class="flex flex-wrap items-end gap-2">
            <label class="text-xs">
              App
              <select name="workload" class="border-black/20 mt-1 block border px-2 py-1.5 text-sm">
                {#each apps as app (app.name)}<option value={app.name}>{app.name}</option>{/each}
              </select>
            </label>
            <label class="text-xs">
              Name
              <input name="name" required placeholder="STRIPE_KEY" class="border-black/20 mt-1 block border px-2 py-1.5 text-sm" />
            </label>
            <label class="flex-1 text-xs">
              Value
              <input name="value" type="password" required autocomplete="off" class="border-black/20 mt-1 block w-full border px-2 py-1.5 text-sm" />
            </label>
            <button class="border-black/80 border px-3 py-1.5 text-sm">Save</button>
          </form>
          <p class="text-muted-foreground text-xs">Values are write-only: nobody can read them back.</p>
          {@render feedback('setSecret')}
        </section>
      {/if}

      <section class="space-y-3" data-testid="hosting-events">
        <h2 class="text-sm font-semibold">Recent activity</h2>
        <ul class="text-muted-foreground space-y-1 text-xs">
          {#each managed.events.slice().reverse().slice(0, 15) as e (e.id)}
            <li><span class="tabular-nums">{new Date(e.time).toLocaleString()}</span> · {e.message}</li>
          {/each}
        </ul>
      </section>
    </main>
  {/if}
</div>
