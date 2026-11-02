import type { RepoAuthKind } from '../../../../../../../modules/website/github/repos-store'

/**
 * The app page's one sentence on when this app deploys (decision D-3):
 * only GitHub-App repos with push-to-deploy on deploy by themselves; every
 * other repo (public link, deploy key) needs a Redeploy after each push, and
 * the page says so plainly.
 */
export function deployModeText(app: { autoDeploy: boolean; authKind: RepoAuthKind }): string {
  if (app.autoDeploy) return 'Deploys on every push to this branch, and by hand here.'
  const why =
    app.authKind === 'github_app'
      ? 'Push-to-deploy is off for this app.'
      : 'Repos read by public link or deploy key send no push events.'
  return `Pushing to GitHub does not deploy this app — press Redeploy after you push. ${why}`
}
