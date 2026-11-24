import type { System } from './system.ts'

/**
 * ee's own A/B slot (plan/phase-upgrades.md §6.4): install.sh puts each release's ee at
 * /opt/ee/releases/<release>/ee.mjs and points /opt/ee/ee.mjs at it, keeping the one before
 * as /opt/ee/ee.previous.mjs (and nothing older). The ee that ran before the slots existed is
 * kept as /opt/ee/releases/pre-slots/ee.mjs. ee upgrades itself first in the transaction, and the
 * new ee must still run the os release before it: a rollback of os never needs the old ee.
 * The old ee comes back only when the new one cannot serve at all (ee.service down during the
 * watch): then the upgrade process points the link back and restarts ee.service.
 */

export const EE_LINK = '/opt/ee/ee.mjs'
export const EE_PREVIOUS = '/opt/ee/ee.previous.mjs'

async function readlink(sys: Pick<System, 'run'>, path: string): Promise<string | null> {
  const r = await sys.run('readlink', [path])
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null
}

/** Swap a link atomically (a new link next to it, renamed over it). */
async function relink(sys: Pick<System, 'run'>, link: string, target: string): Promise<void> {
  for (const [cmd, args] of [
    ['ln', ['-sfn', target, `${link}.ee-tmp`]],
    ['mv', ['-Tf', `${link}.ee-tmp`, link]],
  ] as const) {
    const r = await sys.run(cmd, [...args])
    if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr.trim()}`)
  }
}

/** Which ee runs and which one is kept to go back to (null when ee is not in slots yet). */
export async function eeSlots(sys: Pick<System, 'run'>): Promise<{ current: string | null; previous: string | null }> {
  return { current: await readlink(sys, EE_LINK), previous: await readlink(sys, EE_PREVIOUS) }
}

/** Point ee back at the one kept before it (the one left becomes the kept one); returns the ee that runs now. */
export async function revertEe(sys: Pick<System, 'run'>): Promise<string> {
  const { current, previous } = await eeSlots(sys)
  if (!previous) throw new Error('no earlier ee is kept on this server (/opt/ee/ee.previous.mjs)')
  if (!current) throw new Error(`${EE_LINK} is not a link into ee's slots`)
  await relink(sys, EE_LINK, previous)
  await relink(sys, EE_PREVIOUS, current)
  return previous
}
