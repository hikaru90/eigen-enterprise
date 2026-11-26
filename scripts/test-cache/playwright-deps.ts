// Test cache for browser e2e (scripts/test-cache/README.md): Playwright global setup, after the
// harness's own (src/routes/e2e/global-setup.ts). When the gate records (EE_E2E_DEPS=1), the
// code that ran on each shard's dev server up to here (start, readiness check, the shard's
// owner) is noted as "startup" — a change there re-runs every e2e file — and at the end every
// server's import graph is merged. Both go to EE_E2E_DEPS_OUT.
import { writeFileSync } from 'node:fs'
import path from 'node:path'

type Graph = { importers: Record<string, string[]>; inner: string[]; seen: string[] }

function shardUrls(): string[] {
  const shards = JSON.parse(process.env.E2E_SHARDS ?? 'null') as { baseURL: string }[] | null
  if (!shards?.length)
    throw new Error('e2e deps: E2E_SHARDS is not set (playwright.config.ts sets it)')
  return shards.map((s) => s.baseURL)
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok)
    throw new Error(`e2e deps: the dev server answered ${res.status} to ${url} (is the plugin on?)`)
  return (await res.json()) as T
}

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.EE_E2E_DEPS !== '1') return undefined
  const out = process.env.EE_E2E_DEPS_OUT
  if (!out) throw new Error('e2e deps: EE_E2E_DEPS_OUT must be set when EE_E2E_DEPS=1')
  const urls = shardUrls()
  const taken = await Promise.all(
    urls.map((u) =>
      json<{ files: string[]; inner: string[] }>(`${u}/__e2e-deps/take`, { method: 'POST' }),
    ),
  )
  const union = (lists: string[][]) => [...new Set(lists.flat())].sort()
  writeFileSync(
    path.join(out, 'startup.json'),
    JSON.stringify({
      files: union(taken.map((t) => t.files)),
      inner: union(taken.map((t) => t.inner)),
    }),
  )
  return async () => {
    const graphs = await Promise.all(urls.map((u) => json<Graph>(`${u}/__e2e-deps/graph`)))
    const importers: Record<string, Set<string>> = {}
    for (const g of graphs)
      for (const [file, imps] of Object.entries(g.importers))
        for (const i of imps) (importers[file] ??= new Set()).add(i)
    const merged: Graph = {
      importers: Object.fromEntries(Object.entries(importers).map(([k, v]) => [k, [...v].sort()])),
      inner: union(graphs.map((g) => g.inner)),
      seen: union(graphs.map((g) => g.seen)),
    }
    writeFileSync(path.join(out, 'graph.json'), JSON.stringify(merged))
  }
}
