import type { CoworkerKey } from '../types'
import type { Script, ScriptedRequest } from './gateway'

/**
 * The mock model's lines for the Does scenarios (pure). A co-worker is
 * recognised by the role card its turn's prompt opens with
 * (`You are <name> (@<handle>)`, prompt.ts), the trigger's author by the
 * first line of the turn's input (`<name> (@<handle>, …):`). The text is the
 * script; what the product does with it is what the suite grades.
 */

export type ScriptSeat = { name: string; handle: string }
export type ScriptCast = Record<CoworkerKey, ScriptSeat> & { asker: ScriptSeat }

/** The marker the launch scenario's captured thought carries (state check, not meaning). */
export const LAUNCH_THOUGHT_MARKER = 'CW-LAUNCH-PLAN-1'

export function coworkerOf(req: ScriptedRequest, cast: ScriptCast): CoworkerKey | null {
  const keys: CoworkerKey[] = ['marketing', 'gtm', 'designer']
  return keys.find((k) => req.system.includes(`You are ${cast[k].name} (@${cast[k].handle})`)) ?? null
}

const from = (req: ScriptedRequest, seat: ScriptSeat) => req.input.startsWith(`${seat.name} (`)

/**
 * Launch: the asker → Marketing (captures its plan as a thought, then asks
 * GTM) → GTM → Marketing (asks the Designer) → Designer → Marketing answers
 * the asker. Five co-worker turns in one thread.
 */
export function launchScript(cast: ScriptCast, product: string): Script {
  const { marketing, gtm, designer, asker } = cast
  return (req) => {
    const who = coworkerOf(req, cast)
    if (who === 'marketing') {
      if (from(req, asker)) {
        if (req.lastRole === 'tool') return { content: `Story for ${product}: small agencies get their hours back. @${gtm.handle} which segment and price do we launch with?` }
        if (req.tools.includes('memory.capture_thought')) {
          return { toolCall: { name: 'memory.capture_thought', arguments: { raw: `Launch plan for ${product} (${LAUNCH_THOUGHT_MARKER}): lead with the hours small agencies get back.` } } }
        }
        return { content: `Story for ${product}: small agencies get their hours back. @${gtm.handle} which segment and price do we launch with?` }
      }
      if (from(req, gtm)) return { content: `@${designer.handle} we need the launch page for ${product}: the segment and price are in GTM's answer above. What does it look like?` }
      if (from(req, designer)) {
        return {
          content: `@${asker.handle} the launch plan for ${product}: the story is the hours small agencies get back; GTM launches to agencies of 5–20 people, per seat, annual first; the Designer's page is one screen in Fjord Blue with one button.`,
        }
      }
      return null
    }
    if (who === 'gtm' && from(req, marketing)) return { content: `Agencies with 5–20 people, priced per seat, annual first. @${marketing.handle} that is the segment to lead with.` }
    if (who === 'designer' && from(req, marketing)) return { content: `One screen, one sentence, one button, Fjord Blue on white. @${marketing.handle} here is the page.` }
    return null
  }
}

/** Ping-pong: the two co-workers keep @mentioning each other; only the thread budget ends it. */
export function pingPongScript(cast: ScriptCast, between: [CoworkerKey, CoworkerKey]): Script {
  const [a, b] = between
  let n = 0
  return (req) => {
    const who = coworkerOf(req, cast)
    if (who !== a && who !== b) return null
    n += 1
    const other = who === a ? cast[b] : cast[a]
    return { content: `${who === a ? 'ping' : 'pong'} ${n} @${other.handle}` }
  }
}

