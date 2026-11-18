import { fleetAuthorized } from './seats'

export type FleetMailDomain = { name: string; receive: boolean }

/**
 * The domains the company wants for eigenEnterprise Mail (plan/managed-mail.md
 * D5, Contract): ee reads them on loopback with EE_FLEET_LOCAL_TOKEN and sends
 * them up in report.mail.domains; the control plane provisions from that.
 */
export function mailDomainsHandler(deps: {
  token: string | undefined
  list: () => Promise<FleetMailDomain[]>
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const denied = fleetAuthorized(deps.token, request)
    if (denied) return denied
    return Response.json({ domains: await deps.list() })
  }
}
