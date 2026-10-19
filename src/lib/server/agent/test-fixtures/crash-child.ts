// Crash test child: opens the durable harness on <dir>, submits one turn whose
// model call never returns, prints IN_FLIGHT, and waits to be SIGKILLed.
import { join } from 'node:path'
import { DurableLoopEngine } from '$lib/kernel/engines/durable'
import { getDurableHarness } from '../durable-harness'
import { FileIndex } from './file-index'

const dir = process.argv[2]!
const index = new FileIndex(join(dir, 'index.json'))
const deps = {
  env: { EE_AGENT_STATE_DIR: dir },
  index,
  onReport: () => {},
  complete: async () => {
    process.stdout.write('IN_FLIGHT\n')
    return new Promise<never>(() => {}) // the model call is in flight when we die
  },
}
const engine = new DurableLoopEngine({
  harness: { conversation: async (input) => (await getDurableHarness(deps)).engineHarness.conversation(input) },
  instructions: 'You are a test agent.',
})
await engine.run('s1', 'crash me', {
  agent: { id: 'orchestrator' },
  llmUserId: 'alice',
  listTools: () => [],
  executeTool: async () => null,
} as never)
