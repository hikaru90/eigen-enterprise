// Crash test child: opens the durable harness on <dir>, starts one turn whose
// model call never returns, prints IN_FLIGHT, and waits to be SIGKILLed.
// Mode `chat` (default): a chat turn through the engine. Mode `background`: a
// background run recorded with run principal `agent:factory`.
import { join } from 'node:path'
import { DurableLoopEngine } from '$lib/kernel/engines/durable'
import { getDurableHarness } from '../durable-harness'
import { FileIndex } from './file-index'

const dir = process.argv[2]!
const mode = process.argv[3] ?? 'chat'
const index = new FileIndex(join(dir, 'index.json'))
const deps = {
  env: { EE_AGENT_STATE_DIR: dir },
  index,
  onReport: () => {},
  complete: async () => {
    process.stdout.write('IN_FLIGHT\n')
    return new Promise<never>(() => {}) // the model call is in flight when we die
  },
  runAsPrincipal: async () => {
    throw new Error('crash child never executes tools')
  },
  mirrorResumedChatTurn: async () => {
    throw new Error('crash child never mirrors')
  },
}

if (mode === 'background') {
  const box = await getDurableHarness(deps)
  await box.engineHarness.startBackgroundRun({
    conversationKey: 'factory:ticket-7',
    agentId: 'factory',
    principalId: 'agent:factory',
    llmUserId: 'factory-billing',
    instructions: 'You are the factory.',
    prompt: 'build ticket 7',
    tools: [
      {
        name: 'memory.echo',
        description: 'Echo back the input',
        parametersJsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ],
  })
  await new Promise<never>(() => {}) // nobody awaits a background run; wait to be killed
} else {
  const engine = new DurableLoopEngine({
    harness: {
      conversation: async (input) => (await getDurableHarness(deps)).engineHarness.conversation(input),
      startBackgroundRun: async (input) => (await getDurableHarness(deps)).engineHarness.startBackgroundRun(input),
    },
    instructions: 'You are a test agent.',
  })
  await engine.run('s1', 'crash me', {
    agent: { id: 'orchestrator' },
    llmUserId: 'alice',
    listTools: () => [],
    executeTool: async () => null,
  } as never)
}
