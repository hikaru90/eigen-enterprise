<script lang="ts">
  /**
   * The build contract form, for repos without an ee.json. What it says is
   * stored in the company repo by the server (never in the app's repo).
   * Runtimes come from the server's catalog only (D16).
   */
  let { nodeVersions, open = false }: { nodeVersions: string[]; open?: boolean } = $props()

  let useForm = $state(open)
</script>

<fieldset class="flex flex-col gap-3 rounded-md border border-border p-4">
  <label class="flex items-center gap-2 text-sm">
    <input type="checkbox" name="useForm" bind:checked={useForm} />
    This repo has no ee.json — tell Eigen how to build and start it
  </label>
  {#if useForm}
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="flex flex-col gap-1 text-sm">
        Runtime
        <select name="runtime" class="rounded-md border border-border bg-background px-2 py-1.5">
          {#each nodeVersions as v (v)}
            <option value={`node@${v}`}>Node.js {v}</option>
          {/each}
          <option value="static">Static files</option>
        </select>
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Health check path
        <input
          name="health"
          value="/"
          class="rounded-md border border-border bg-background px-2 py-1.5"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Install command
        <input
          name="install"
          value="npm install --omit=dev"
          class="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Build command (optional)
        <input
          name="build"
          placeholder="npm run build"
          class="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Start command
        <input
          name="start"
          value="node index.js"
          class="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        Port variable (optional)
        <input
          name="portEnv"
          placeholder="PORT is always set"
          class="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm sm:col-span-2">
        Folder to serve (static sites only)
        <input
          name="staticDir"
          placeholder="dist"
          class="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
        />
      </label>
    </div>
    <p class="text-xs text-foreground/55">
      Commands run directly, not through a shell. The app must listen on the port in PORT.
    </p>
  {/if}
</fieldset>
