import type { ActivityResult } from '../../../../../modules/website/activity-tools'
import type { AppListRepository, AppListResult } from '../../../../../modules/website/apps/tools'
import type { ConnectedRepoView } from '../../../../../modules/website/github/connect-tools'
import type { PageServerLoad } from './$types'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { logAppFailure, ownerRun, plainAppMessage } from '$lib/server/website/owner-run'

/** How many activity rows the right rail shows. */
const ACTIVITY_ITEMS = 10

/**
 * /m/website: the Website module's front page — its apps (D-W7: apps are the
 * point of the module) with the module's recent activity beside them, laid
 * out like the overview. ee being unreachable is a state the page shows
 * explicitly (managed:false), not an error; anything else fails loud.
 */
export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  let apps: AppListResult | null = null
  let appsError: string | null = null
  let savedRepositories: Omit<AppListRepository, 'apps'>[] = []
  let repositoriesError: string | null = null
  try {
    apps = await ownerRun<AppListResult>(user, 'website.app_list', {})
  } catch (err) {
    logAppFailure('website.app_list', err)
    appsError = plainAppMessage(err)
    // Repository inventory is a separate capability from deployment status.
    // Keep the server failure visible while reading the saved repository records.
    try {
      const inventory = await ownerRun<{ repos: ConnectedRepoView[] }>(
        user,
        'website.github_list_repos',
        {},
      )
      savedRepositories = inventory.repos.map((repo) => ({
        fullName: repo.fullName,
        branch: repo.branch,
        htmlUrl: repo.htmlUrl,
        visibility: repo.visibility,
        authKind: repo.authKind,
      }))
    } catch (repoErr) {
      logAppFailure('website.github_list_repos', repoErr)
      repositoriesError = plainAppMessage(repoErr)
    }
  }
  let activity: ActivityResult | null = null
  let activityError: string | null = null
  try {
    activity = await ownerRun<ActivityResult>(user, 'website.activity', { limit: ACTIVITY_ITEMS })
  } catch (err) {
    // The page stays up; the rail states what went wrong, in plain words.
    if (!(err instanceof Error && err.name === 'AppUserError'))
      logAppFailure('website.activity', err)
    activityError = plainAppMessage(err)
  }
  return { apps, appsError, savedRepositories, repositoriesError, activity, activityError }
}
