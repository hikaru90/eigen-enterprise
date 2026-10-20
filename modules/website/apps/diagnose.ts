import { z } from 'zod'
import type { AppContract, EeDeploy } from '$lib/server/ee/client'
import { extractBatchChatContent } from '$lib/server/llm/batch-json'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { AppUserError, contractFormSchema } from './contract'

/**
 * "Ask AI what went wrong" (code ↔ harness ↔ user): a failed deploy goes to
 * the model with what ee recorded (stage, plain cause, log tail), the build
 * contract and the repo's file list. The MODEL decides what the problem was;
 * this code only assembles the evidence and validates the JSON answer.
 * Every call goes through the LLM gateway (cost tracked there).
 */

/** Contract fields the model may propose, in the build form's own terms. */
const CMD = z.string().trim().max(400)
export const contractChangesSchema = z
  .object({
    install: CMD.optional(),
    build: CMD.optional(),
    start: CMD.optional(),
    health: contractFormSchema.shape.health.removeDefault().optional(),
    nodeVersion: contractFormSchema.shape.nodeVersion,
    portEnv: contractFormSchema.shape.portEnv,
  })
  .strict()

export const diagnosisSchema = z
  .object({
    cause: z.string().trim().min(1).max(2000),
    fix: z.string().trim().min(1).max(2000),
    suggestedContractChanges: contractChangesSchema.nullable().optional(),
  })
  .strict()

export type Diagnosis = z.infer<typeof diagnosisSchema>
export type ContractChanges = z.infer<typeof contractChangesSchema>

export type DiagnoseLlm = (input: {
  userId: string
  messages: ChatMessage[]
  responseFormat: 'json_object'
  logContext: string
  temperature: number
  maxTokens: number
}) => Promise<unknown>

export type DeployFailure = {
  app: string
  deploy: EeDeploy
  /** The stage that failed (the one before `failed`). */
  failedStage: string
  logTail: string[]
  contract: AppContract | null
  contractSource: 'repo' | 'form'
  files: string[] | null
}

const LOG_TAIL = 120

const SHAPE = `{
  "cause": string   // one or two plain sentences: what went wrong, for a non-developer
  "fix": string     // what to change, in plain words
  "suggestedContractChanges"?: {   // ONLY when changing the build contract fixes it; omit otherwise
    "install"?: string, "build"?: string, "start"?: string, "health"?: string,
    "nodeVersion"?: string, "portEnv"?: string
  } | null
}`

export function diagnosisMessages(f: DeployFailure): ChatMessage[] {
  const contract = f.contract
    ? JSON.stringify(
        {
          runtime: f.contract.runtime,
          node: f.contract.node ?? null,
          build: f.contract.build.map((s) => s.join(' ')),
          start: f.contract.start?.join(' ') ?? null,
          health: f.contract.health,
          portEnv: f.contract.portEnv ?? 'PORT (default)',
        },
        null,
        2,
      )
    : 'unknown'
  return [
    {
      role: 'system',
      content: [
        'You diagnose failed deploys on an Eigen Enterprise server. A deploy runs: fetching (git) → building (install/build commands, sandboxed) → starting (a systemd unit runs the start command) → health (GET <health path> on the port given in $PORT must answer 2xx/3xx).',
        'Commands are run directly (argv), never through a shell; "node" means the pinned Node.js runtime. The app runs from the release directory with a read-only filesystem except its state directory.',
        `Answer with ONE JSON object of exactly this shape:\n${SHAPE}`,
        f.contractSource === 'repo'
          ? "The build contract comes from the repo's own ee.json, so it can't be changed here: put any contract change in `fix` (edit ee.json in the repo) and omit suggestedContractChanges."
          : 'The build contract comes from the owner\'s build form. When a different install/build/start command or health path fixes it, give it in suggestedContractChanges (start like "node server.js", health like "/").',
        'Base the answer on the evidence. Never invent files that the file list does not show.',
      ].join('\n\n'),
    },
    {
      role: 'user',
      content: [
        `App: ${f.app}`,
        `Failed at stage: ${f.failedStage}`,
        `ee's recorded cause: ${f.deploy.error ?? 'none recorded'}`,
        `Build contract (${f.contractSource === 'repo' ? "repo's ee.json" : 'build form'}):\n${contract}`,
        f.files
          ? `Files in the repo at this commit (${f.files.length}):\n${f.files.join('\n')}`
          : 'Files in the repo: not available',
        `Log of this deploy attempt (last ${Math.min(LOG_TAIL, f.logTail.length)} lines, secrets redacted):\n${f.logTail.slice(-LOG_TAIL).join('\n') || '(empty)'}`,
      ].join('\n\n'),
    },
  ]
}

export async function diagnoseDeploy(
  userId: string,
  failure: DeployFailure,
  llm: DiagnoseLlm,
): Promise<Diagnosis> {
  let response: unknown
  try {
    response = await llm({
      userId,
      messages: diagnosisMessages(failure),
      responseFormat: 'json_object',
      logContext: 'app_deploy_diagnose',
      temperature: 0,
      maxTokens: 4000,
    })
  } catch (err) {
    throw new AppUserError(
      "The AI couldn't be reached to look at this deploy. Check the AI provider under Settings, then ask again.",
      { cause: err },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(extractBatchChatContent(response, 'app_deploy_diagnose'))
  } catch (err) {
    throw new AppUserError("The AI's answer couldn't be read. Ask again.", { cause: err })
  }
  const checked = diagnosisSchema.safeParse(parsed)
  if (!checked.success) {
    throw new AppUserError("The AI's answer didn't have the expected shape. Ask again.", {
      cause: checked.error,
    })
  }
  const d = checked.data
  if (failure.contractSource === 'repo' && d.suggestedContractChanges) {
    // The repo's ee.json wins over any form contract: an applied change would do nothing.
    return { cause: d.cause, fix: d.fix }
  }
  if (d.suggestedContractChanges && Object.keys(d.suggestedContractChanges).length === 0) {
    return { cause: d.cause, fix: d.fix }
  }
  return d
}

/** The gateway caller (lazy: keeps the gateway's DB handle out of unit tests). */
export const gatewayDiagnoseLlm: DiagnoseLlm = async (input) => {
  const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
  return llmChatCompletion(input)
}
