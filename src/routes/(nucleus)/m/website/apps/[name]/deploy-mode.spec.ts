import { describe, expect, it } from 'vitest'
import { deployModeText } from './deploy-mode'

describe('deployModeText (D-3: manual redeploy for deploy-key / public repos)', () => {
  it('tells the owner of a public repo to press Redeploy after pushing', () => {
    const t = deployModeText({ autoDeploy: false, authKind: 'public' })
    expect(t).toMatch(/press Redeploy after you push/i)
    expect(t).toMatch(/does not deploy/i)
  })

  it('says the same for a deploy-key repo', () => {
    expect(deployModeText({ autoDeploy: false, authKind: 'deploy_key' })).toMatch(
      /press Redeploy after you push/i,
    )
  })

  it('promises push-to-deploy only when it is on', () => {
    const t = deployModeText({ autoDeploy: true, authKind: 'github_app' })
    expect(t).toMatch(/every push/i)
    expect(t).not.toMatch(/press Redeploy after/i)
  })

  it('GitHub App repo with push-to-deploy off: deploys by hand', () => {
    expect(deployModeText({ autoDeploy: false, authKind: 'github_app' })).toMatch(
      /press Redeploy after you push/i,
    )
  })
})
