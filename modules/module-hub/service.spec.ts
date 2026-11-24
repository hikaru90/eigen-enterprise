import { describe, expect, it } from 'vitest'
import { TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI } from '../../contracts/fixtures/module-hub-test-key'
import { BUNDLE_LIMITS, readBundle } from '../../contracts/module-bundle'
import { manifestSha256 } from '../../contracts/module-manifest'
import { verifyReceipt } from '../../contracts/module-receipt'
import { revokeInstall } from '../contribute/hub/service'
import { testInstall } from '../contribute/hub/test-fixtures'
import { lockCatalog } from './checks'
import { MODULE_HUB_PATHS, type HubProblem } from './contract'
import { fetchModuleBundle, getHubModule, getHubVersion, hubVersionFile, hubVersionTree, listHubModules, publishModule, reportModuleRun } from './service'
import { bundleOf, COMMIT_A, COMMIT_B, helloFiles, helloYaml, moduleHubFixture, publishBody, renamedEntryBundle, withFile } from './test-fixtures'

// Planted values are built at runtime: this file is a tracked OSS file too.
const PLANTED = ['sk', 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2'].join('-')

const problemsOf = (body: Record<string, unknown>) => body.problems as HubProblem[]

describe('publish (plan/phase-upgrades-u2.md §6.2)', () => {
  it('publishing hello gives a 201 receipt that verifyReceipt accepts; publishing it again gives 200 with the same receipt', async () => {
    const f = moduleHubFixture()
    const i = await f.registered(testInstall())
    const b = bundleOf()
    const first = await publishModule(f.deps, f.publishReq(i, publishBody(b)))
    expect(first.status).toBe(201)
    const receipt = first.body.receipt as Record<string, unknown>
    const verdict = verifyReceipt(receipt, [TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI])
    expect(verdict.ok).toBe(true)
    expect(receipt).toMatchObject({
      installId: i.installId,
      moduleId: 'hello',
      version: '0.1.0',
      commit: COMMIT_A,
      bundleSha256: b.sha256,
      manifestSha256: manifestSha256(b.manifest),
      license: 'Apache-2.0',
      deprecatedUses: [],
    })
    expect(f.summaries).toEqual([b.sha256])

    const again = await publishModule(f.deps, f.publishReq(i, publishBody(b)))
    expect(again).toEqual({ status: 200, body: { receipt } })
    // The bytes are kept by sha.
    expect(await f.bundles.get(b.sha256)).toEqual(new Uint8Array(b.bytes))
  })

  it('409 for the same commit with another bundle, naming the commit check', async () => {
    const f = moduleHubFixture()
    const i = await f.registered(testInstall())
    expect((await publishModule(f.deps, f.publishReq(i, publishBody(bundleOf())))).status).toBe(201)
    const changed = bundleOf(withFile(helloFiles(), 'README.md', 'Hello, again.\n'))
    const out = await publishModule(f.deps, f.publishReq(i, publishBody(changed)))
    expect(out.status).toBe(409)
    expect(problemsOf(out.body)).toEqual([expect.objectContaining({ check: 'commit' })])
    // A new commit of the same change is fine.
    expect((await publishModule(f.deps, f.publishReq(i, publishBody(changed, { commit: COMMIT_B })))).status).toBe(201)
  })

  it('413 for a bundle over the packed limit, naming the bundle check', async () => {
    const f = moduleHubFixture()
    const i = await f.registered(testInstall())
    const b = bundleOf()
    const huge = Buffer.alloc(BUNDLE_LIMITS.packedBytes + 1, 1).toString('base64')
    const out = await publishModule(f.deps, f.publishReq(i, publishBody(b, { bundle_b64: huge })))
    expect(out.status).toBe(413)
    expect(problemsOf(out.body)[0]).toMatchObject({ check: 'bundle' })
  })

  it('422 reports a planted secret by path:line and never its value', async () => {
    const f = moduleHubFixture()
    const i = await f.registered(testInstall())
    const index = new TextDecoder().decode(helloFiles().find((x) => x.path === 'index.mjs')!.content)
    const planted = bundleOf(withFile(helloFiles(), 'index.mjs', `${index}\nconst key = "${PLANTED}"\n`))
    const out = await publishModule(f.deps, f.publishReq(i, publishBody(planted)))
    expect(out.status).toBe(422)
    const problems = problemsOf(out.body)
    expect(problems).toEqual([{ check: 'secrets', path: 'index.mjs', line: index.split('\n').length + 1, message: expect.any(String) }])
    expect(JSON.stringify(out.body)).not.toContain(PLANTED)
    expect(f.moduleStore.versionsBySha.size).toBe(0)
  })

  it('422 refuses a wrong licence, a use outside the lock and a manifest that differs — every problem collected', async () => {
    const f = moduleHubFixture()
    const i = await f.registered(testInstall())
    const yaml = helloYaml().replace('license: Apache-2.0', 'license: MIT').replace('tools: [members.list]', 'tools: [members.list, payroll.pay_everyone]')
    const b = bundleOf(withFile(helloFiles(), 'module.yaml', yaml.replace('license: MIT', 'license: Apache-2.0')))
    // The manifest sent differs from the bundle's module.yaml (another description), has the wrong licence and an unlocked use.
    const sent = { ...b.manifest, license: 'MIT', description: 'Something else entirely.' }
    const out = await publishModule(f.deps, f.publishReq(i, publishBody(b, { manifest: sent })))
    expect(out.status).toBe(422)
    const checks = problemsOf(out.body).map((p) => [p.check, p.path])
    expect(checks).toEqual(
      expect.arrayContaining([
        ['license', 'manifest.license'],
        ['manifest', 'module.yaml'],
        ['uses', 'uses.tools:payroll.pay_everyone'],
      ]),
    )
  })

  it('422 names a missing LICENSE, a sha that is not the bundle and an unsatisfiable core-api', async () => {
    const f = moduleHubFixture()
    const i = await f.registered(testInstall())
    const noLicense = renamedEntryBundle('LICENSE', 'LICENSF')
    const out = await publishModule(f.deps, f.publishReq(i, publishBody(noLicense, { bundle_sha256: 'f'.repeat(64), core_api: '2.0.0' })))
    expect(out.status).toBe(422)
    const checks = problemsOf(out.body).map((p) => p.check)
    expect(checks).toEqual(expect.arrayContaining(['bundle', 'license', 'core_api']))
  })

  it('lists deprecated uses on the receipt instead of refusing them', async () => {
    const f = moduleHubFixture({ catalog: { ...lockCatalog(), deprecated: new Set(['tool:members.list']) } })
    const i = await f.registered(testInstall())
    const out = await publishModule(f.deps, f.publishReq(i, publishBody(bundleOf())))
    expect(out.status).toBe(201)
    expect((out.body.receipt as { deprecatedUses: string[] }).deprecatedUses).toEqual(['tool:members.list'])
  })

  it('a replay gives 401, a revoked install 403, an unknown one 401', async () => {
    const f = moduleHubFixture()
    const i = await f.registered(testInstall())
    const req = f.publishReq(i, publishBody(bundleOf()))
    expect((await publishModule(f.deps, req)).status).toBe(201)
    await expect(publishModule(f.deps, req)).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringMatching(/replay/) })
    await expect(publishModule(f.deps, f.publishReq(testInstall(), publishBody(bundleOf())))).rejects.toMatchObject({ code: 'unauthorized' })
    await revokeInstall(f.deps.hub, i.installId)
    await expect(publishModule(f.deps, f.publishReq(i, publishBody(bundleOf())))).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a body off the strict schema is a 400', async () => {
    const f = moduleHubFixture()
    const i = await f.registered(testInstall())
    await expect(publishModule(f.deps, f.publishReq(i, publishBody(bundleOf(), { extra: true })))).rejects.toMatchObject({ code: 'invalid' })
  })

  it('fails loud without a signing key, storing nothing', async () => {
    const f = moduleHubFixture()
    f.deps.signingKey = () => {
      throw new Error('the module hub signing key is not set')
    }
    const i = await f.registered(testInstall())
    await expect(publishModule(f.deps, f.publishReq(i, publishBody(bundleOf())))).rejects.toThrow(/signing key/)
    expect(f.moduleStore.versionsBySha.size).toBe(0)
  })
})

describe('bundles and runs', () => {
  it('any registered install fetches a published bundle by sha; an unknown sha is 404', async () => {
    const f = moduleHubFixture()
    const a = await f.registered(testInstall())
    const other = await f.registered(testInstall())
    const b = bundleOf()
    await publishModule(f.deps, f.publishReq(a, publishBody(b)))
    const got = await fetchModuleBundle(f.deps, f.req(other, 'GET', MODULE_HUB_PATHS.bundle(b.sha256), ''), b.sha256)
    expect(readBundle(got.bytes).sha256).toBe(b.sha256)
    await expect(fetchModuleBundle(f.deps, f.req(a, 'GET', MODULE_HUB_PATHS.bundle('e'.repeat(64)), ''), 'e'.repeat(64))).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a run report answers which installs run the module', async () => {
    const f = moduleHubFixture()
    const a = await f.registered(testInstall())
    const b = bundleOf()
    await publishModule(f.deps, f.publishReq(a, publishBody(b)))
    const body = JSON.stringify({ v: 1, bundle_sha256: b.sha256, state: 'running' })
    const out = await reportModuleRun(f.deps, f.req(a, 'PUT', MODULE_HUB_PATHS.run('hello'), body), 'hello')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ module_id: 'hello', runs: [{ install_id: a.installId, bundle_sha256: b.sha256, version: '0.1.0', state: 'running' }] })
    await expect(reportModuleRun(f.deps, f.req(a, 'PUT', MODULE_HUB_PATHS.run('other'), body), 'other')).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe("the owner's view (§7)", () => {
  it('lists the module and shows its versions, the installs running it, its code and its summary', async () => {
    const f = moduleHubFixture()
    const a = await f.registered(testInstall())
    const v1 = bundleOf()
    const v2 = bundleOf(withFile(helloFiles(), 'README.md', 'Hello.\n'))
    await publishModule(f.deps, f.publishReq(a, publishBody(v1)))
    f.clock.now += 60_000
    await publishModule(f.deps, f.publishReq(a, publishBody(v2, { commit: COMMIT_B })))
    await reportModuleRun(f.deps, f.req(a, 'PUT', MODULE_HUB_PATHS.run('hello'), JSON.stringify({ v: 1, bundle_sha256: v2.sha256, state: 'running' })), 'hello')
    await f.moduleStore.setSummary(v2.sha256, { does: 'Greets people.', touches: 'Reads members.', sendsOut: 'Nothing.' }, new Date(f.clock.now))

    const list = await listHubModules(f.deps, {})
    expect(list).toEqual({
      modules: [expect.objectContaining({ installId: a.installId, moduleId: 'hello', name: 'Hello', latestVersion: '0.1.0', latestBundleSha256: v2.sha256, versions: 2 })],
      cursor: null,
    })
    expect((await listHubModules(f.deps, { query: 'nothing-like-it' })).modules).toEqual([])

    const detail = await getHubModule(f.deps, a.installId, 'hello')
    expect(detail.versions.map((v) => v.bundleSha256)).toEqual([v2.sha256, v1.sha256])
    expect(detail.versions[0]!.summary).toEqual({ does: 'Greets people.', touches: 'Reads members.', sendsOut: 'Nothing.' })
    expect(detail.runs).toEqual([expect.objectContaining({ installId: a.installId, bundleSha256: v2.sha256, state: 'running' })])

    const version = await getHubVersion(f.deps, v2.sha256)
    expect(version).toMatchObject({ moduleId: 'hello', commit: COMMIT_B, uses: { tools: ['members.list'] }, summary: { does: 'Greets people.' } })
    expect(verifyReceipt(version.receipt, [TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI]).ok).toBe(true)

    const tree = await hubVersionTree(f.deps, v2.sha256)
    expect(tree.files.map((x) => x.path)).toEqual(['LICENSE', 'README.md', 'index.mjs', 'module.yaml', 'package.json', 'test.mjs'])
    const file = await hubVersionFile(f.deps, v2.sha256, 'module.yaml')
    expect(file).toMatchObject({ binary: false, truncated: false, content: helloYaml() })
    await expect(hubVersionFile(f.deps, v2.sha256, 'nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('revoking an install hides its modules from the listing and keeps the code', async () => {
    const f = moduleHubFixture()
    const a = await f.registered(testInstall())
    const b = bundleOf()
    await publishModule(f.deps, f.publishReq(a, publishBody(b)))
    await revokeInstall(f.deps.hub, a.installId)
    expect((await listHubModules(f.deps, {})).modules).toEqual([])
    expect((await getHubVersion(f.deps, b.sha256)).bundleSha256).toBe(b.sha256)
    expect(await f.bundles.get(b.sha256)).not.toBeNull()
  })
})
