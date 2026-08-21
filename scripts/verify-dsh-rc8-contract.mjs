import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const EXPECTED_COMMIT = '141eb6fef83422698aef7a981029e843e8161534'
const sourceRoot = process.env.DSH_SOURCE_DIR
if (sourceRoot === undefined || sourceRoot.trim() === '') {
  throw new Error('DSH_SOURCE_DIR must point to a DeepSeek Harness rc.8 checkout')
}

const root = resolve(sourceRoot)
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (commit !== EXPECTED_COMMIT) {
  throw new Error(`expected DeepSeek Harness ${EXPECTED_COMMIT}, received ${commit}`)
}

const [runtimeIndex, conversationContract, messageContract, slotsContract, inputContract, runtimePackage, conversationPackage] = await Promise.all([
  read('packages/client/runtime/src/client/index.ts'),
  read('packages/client/runtime/src/client/sessions/conversation.ts'),
  read('packages/client/ui-conversation/src/client/conversation-nodes/message.ts'),
  read('packages/client/ui-conversation/src/client/contract/slots.ts'),
  read('packages/client/ui-conversation/src/client/input/contract.ts'),
  read('packages/client/runtime/package.json'),
  read('packages/client/ui-conversation/package.json'),
])

assertMatch(runtimePackage, /"version"\s*:\s*"0\.1\.0-rc\.8"/u, 'runtime package version')
assertMatch(conversationPackage, /"version"\s*:\s*"0\.1\.0-rc\.8"/u, 'conversation package version')
assertMatch(slotsContract, /'conversation\.input\.right':\s*\{\s*kind:\s*'list';\s*scope:\s*'session';\s*owner:\s*InputZone\s*\}/u, 'input-right slot')
assertMatch(slotsContract, /export interface InputZone\s*\{[\s\S]*?readonly session:\s*ConversationSnapshot[\s\S]*?readonly input:\s*InputState[\s\S]*?\}/u, 'input-zone owner snapshots')
assertMatch(slotsContract, /interface SessionStandardProps\s*\{[\s\S]*?useInput:\s*SnapshotSelectorHook<InputState>[\s\S]*?inputActions:\s*InputActions[\s\S]*?\}/u, 'input selector/actions standard props')
assertMatch(runtimeIndex, /interface SessionStandardProps\s*\{[\s\S]*?useSession:\s*SnapshotSelectorHook<ConversationSnapshot>[\s\S]*?sessionId:\s*SessionId[\s\S]*?\}/u, 'session selector standard props')
assertMatch(runtimeIndex, /interface GlobalStandardProps\s*\{[\s\S]*?useSessions:\s*SnapshotSelectorHook<SessionListState>[\s\S]*?\}/u, 'global session-list selector')
assertMatch(conversationContract, /export interface ConversationSnapshot\s*\{[\s\S]*?nodes:\s*readonly ConversationNode\[\][\s\S]*?\}/u, 'conversation user-message snapshot source')
assertMatch(messageContract, /kind:\s*'steering'[\s\S]*?messageId:\s*event\.data\.id[\s\S]*?content:\s*event\.data\.content/u, 'accepted steering follow-up snapshot')
assertMatch(inputContract, /export interface InputActions\s*\{[\s\S]*?setDraft\(text:\s*string\):\s*void[\s\S]*?\}/u, 'public setDraft action')
assertMatch(inputContract, /export interface InputState\s*\{[\s\S]*?readonly phase:\s*'plain'\s*\|\s*'adjudicating'\s*\|\s*'claimed'\s*\|\s*'submitting'/u, 'input submission lifecycle')

process.stdout.write(`DeepSeek Harness rc.8 client contract verified at ${commit}\n`)

async function read(relativePath) {
  return readFile(resolve(root, relativePath), 'utf8')
}

function assertMatch(source, pattern, label) {
  if (!pattern.test(source)) throw new Error(`DeepSeek Harness rc.8 contract mismatch: ${label}`)
}
