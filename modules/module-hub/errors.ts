/**
 * Module hub failures with their HTTP meaning (src/lib/server/module-hub/http.ts
 * maps them). Authentication failures (401/403/429) are the contribute hub's
 * own errors, raised by the injected `authenticate`.
 */
export class ModuleHubError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found',
    message: string,
  ) {
    super(message)
    this.name = 'ModuleHubError'
  }
}

export const MODULE_HUB_ERROR_STATUS: Record<ModuleHubError['code'], number> = {
  invalid: 400,
  not_found: 404,
}
