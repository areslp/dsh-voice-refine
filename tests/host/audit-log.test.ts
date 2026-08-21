import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RefinementAuditLog, redactSensitiveText, type RefinementAuditInput, type RefinementAuditRecord } from '../../src/host/audit-log.js'
import { CONSERVATIVE_GUARD_VERSION } from '../../src/host/refine.js'

const FIXED_NOW = Date.parse('2026-08-20T12:00:00.000Z')
const AUDIT_KEY = 'test-only-audit-identity-key-32chars'
const OPENAI_LIKE_TOKEN = ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-')
const SOURCE_CONTROL_LIKE_TOKEN = [['gl', 'pat'].join(''), 'abcdefghijklmnopqrstuvwxyz'].join('-')
const GITHUB_CLASSIC_LIKE_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz012345'].join('_')
const GITHUB_FINE_GRAINED_LIKE_TOKEN = ['github', 'pat', 'abcdefghijklmnopqrstuvwxyz012345'].join('_')
const SLACK_LIKE_TOKEN = ['xoxb', '1234567890', 'abcdefghijklmnopqrstuvwxyz'].join('-')
const HIGH_ENTROPY_LIKE_VALUE = ['aB3dE5fG7hI9jK1m', 'N3pQ5rS7tU9vW1xY'].join('')
const AWS_ACCESS_KEY_LIKE_ID = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
const AWS_SECRET_LIKE_KEY = ['wJalrXUtnFEMI/K7MDENG/bPxRfiCY', 'EXAMPLEKEY'].join('')

test('audit log writes private daily NDJSON with useful tuning fields and secret redaction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-refine-audit-'))
  const audit = new RefinementAuditLog({
    enabled: true,
    storePath: directory,
    retentionDays: 30,
    maxPendingEntries: 100,
    identityKeyEnv: 'AUDIT_KEY',
    environment: { AUDIT_KEY },
    now: () => FIXED_NOW,
  })
  await audit.record(auditInput({
    sessionId: 'session-secret',
    rawText: `use api_key=${OPENAI_LIKE_TOKEN} and Bearer private-token`,
    selectedText: `use api_key=${OPENAI_LIKE_TOKEN} and Bearer private-token`,
    trace: {
      decision: 'rejected',
      reason: 'guard-rejected',
      guardVersion: CONSERVATIVE_GUARD_VERSION,
      proposalText: 'use token=visible-secret',
    },
  }))
  await audit.flush()

  const path = join(directory, 'refine-2026-08-20.ndjson')
  const record = JSON.parse((await readFile(path, 'utf8')).trim()) as RefinementAuditRecord
  assert.equal(record.schemaVersion, 1)
  assert.equal(record.decision, 'rejected')
  assert.equal(record.reason, 'guard-rejected')
  assert.equal(record.guardVersion, CONSERVATIVE_GUARD_VERSION)
  assert.equal(record.eventType, 'refinement')
  assert.equal(record.sessionHash?.length, 24)
  assert.equal(record.scopeHash?.length, 24)
  assert.equal(JSON.stringify(record).includes('session-secret'), false)
  assert.equal(JSON.stringify(record).includes(OPENAI_LIKE_TOKEN), false)
  assert.equal(JSON.stringify(record).includes('private-token'), false)
  assert.match(record.rawText, /\[REDACTED/u)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})

test('audit log serializes concurrent writes and prunes expired daily files only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-refine-audit-prune-'))
  const expiredPath = join(directory, 'refine-2026-08-17.ndjson')
  const retainedPath = join(directory, 'refine-2026-08-19.ndjson')
  const unrelatedPath = join(directory, 'notes.txt')
  const malformedDatePath = join(directory, 'refine-2026-99-99.ndjson')
  await writeFile(expiredPath, '{}\n')
  await writeFile(retainedPath, '{}\n')
  await writeFile(unrelatedPath, 'keep')
  await writeFile(malformedDatePath, 'keep')
  const audit = new RefinementAuditLog({
    enabled: true,
    storePath: directory,
    retentionDays: 2,
    maxPendingEntries: 100,
    identityKeyEnv: 'AUDIT_KEY',
    environment: { AUDIT_KEY },
    now: () => FIXED_NOW,
  })
  await Promise.all(Array.from({ length: 12 }, (_, index) => audit.record(auditInput({ rawText: `raw-${index}`, selectedText: `raw-${index}` }))))
  await audit.flush()

  const lines = (await readFile(join(directory, 'refine-2026-08-20.ndjson'), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 12)
  assert.deepEqual(new Set(lines.map(line => (JSON.parse(line) as RefinementAuditRecord).rawText)).size, 12)
  await assert.rejects(stat(expiredPath), { code: 'ENOENT' })
  assert.equal((await stat(retainedPath)).isFile(), true)
  assert.equal(await readFile(unrelatedPath, 'utf8'), 'keep')
  assert.equal(await readFile(malformedDatePath, 'utf8'), 'keep')
})

test('disabled audit logging creates no files', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-refine-audit-disabled-'))
  const directory = join(parent, 'audit')
  const audit = new RefinementAuditLog({
    enabled: false,
    storePath: directory,
    retentionDays: 30,
    maxPendingEntries: 100,
    identityKeyEnv: 'AUDIT_KEY',
  })
  await audit.record(auditInput())
  await assert.rejects(stat(directory), { code: 'ENOENT' })
})

test('enabled audit requires a dedicated identity key and always redacts common token forms', () => {
  assert.throws(() => new RefinementAuditLog({
    enabled: true,
    storePath: '',
    retentionDays: 30,
    maxPendingEntries: 100,
    identityKeyEnv: 'MISSING_AUDIT_KEY',
    environment: {},
  }), /at least 32 characters/u)
  const redacted = redactSensitiveText([
    SOURCE_CONTROL_LIKE_TOKEN,
    GITHUB_CLASSIC_LIKE_TOKEN,
    GITHUB_FINE_GRAINED_LIKE_TOKEN,
    HIGH_ENTROPY_LIKE_VALUE,
    SLACK_LIKE_TOKEN,
    AWS_ACCESS_KEY_LIKE_ID,
    'token: first second',
    `AWS_SECRET_ACCESS_KEY=${AWS_SECRET_LIKE_KEY}`,
    'client_secret=super-secret-value',
  ].join(' '))
  assert.equal(redacted.includes('abcdefghijklmnopqrstuvwxyz'), false)
  assert.equal(redacted.includes(SLACK_LIKE_TOKEN.slice(0, 5)), false)
  assert.equal(redacted.includes(AWS_ACCESS_KEY_LIKE_ID), false)
  assert.equal(redacted.includes('first second'), false)
  assert.equal(redacted.includes(AWS_SECRET_LIKE_KEY.slice(0, 12)), false)
  assert.equal(redacted.includes('super-secret-value'), false)
  assert.match(redacted, /REDACTED/u)
})

test('audit log truncates text and refuses symbolic-link storage paths without throwing to callers', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-refine-audit-link-'))
  const realDirectory = join(parent, 'real')
  const linkedDirectory = join(parent, 'linked')
  await writeFile(realDirectory, 'not-a-directory')
  await symlink(realDirectory, linkedDirectory)
  const errors: unknown[] = []
  const linkedAudit = new RefinementAuditLog({
    enabled: true,
    storePath: linkedDirectory,
    retentionDays: 30,
    maxPendingEntries: 1,
    identityKeyEnv: 'AUDIT_KEY',
    environment: { AUDIT_KEY },
    now: () => FIXED_NOW,
    onError: error => { errors.push(error) },
  })
  const linkedInput = auditInput({ eventId: 'linked-1' })
  const accepted = [
    linkedAudit.record(linkedInput),
    linkedAudit.record(auditInput({ eventId: 'linked-2' })),
    linkedAudit.record(auditInput({ eventId: 'linked-3' })),
  ]
  await linkedAudit.flush()
  assert.deepEqual(accepted, [true, true, false])
  assert.ok(errors.some(error => String(error).includes('queue is full')))
  assert.ok(errors.length >= 2)

  await unlink(linkedDirectory)
  await mkdir(linkedDirectory, { mode: 0o700 })
  assert.equal(linkedAudit.recordDelivery({
    eventId: linkedInput.eventId,
    refinement: linkedInput,
    status: 'written',
    reason: 'draft-written',
    placement: 'replace',
  }), true)
  await linkedAudit.flush()
  const recovered = JSON.parse((await readFile(join(linkedDirectory, 'refine-2026-08-20.ndjson'), 'utf8')).trim()) as {
    eventType: string
    eventId: string
    refinement: RefinementAuditRecord
  }
  assert.equal(recovered.eventType, 'delivery')
  assert.equal(recovered.eventId, linkedInput.eventId)
  assert.equal(recovered.refinement.rawText, linkedInput.rawText)

  const directory = await mkdtemp(join(tmpdir(), 'dsh-refine-audit-truncate-'))
  const audit = new RefinementAuditLog({
    enabled: true,
    storePath: directory,
    retentionDays: 30,
    maxPendingEntries: 10,
    identityKeyEnv: 'AUDIT_KEY',
    environment: { AUDIT_KEY },
    now: () => FIXED_NOW,
  })
  await audit.record(auditInput({ rawText: `${'x'.repeat(15_995)} ${OPENAI_LIKE_TOKEN}` }))
  await audit.flush()
  const record = JSON.parse((await readFile(join(directory, 'refine-2026-08-20.ndjson'), 'utf8')).trim()) as RefinementAuditRecord
  assert.ok(record.rawText.length <= 16_000)
  assert.deepEqual(record.truncatedFields, ['rawText'])
  assert.equal(record.rawText.includes('sk-'), false)
  assert.equal(record.rawText.includes('abcdef'), false)
})

function auditInput(overrides: Partial<RefinementAuditInput> = {}): RefinementAuditInput {
  return {
    eventId: 'event-1',
    scope: 'opaque-scope',
    rawText: 'raw transcript',
    selectedText: 'refined transcript',
    trace: {
      decision: 'accepted',
      reason: 'accepted',
      guardVersion: CONSERVATIVE_GUARD_VERSION,
      proposalText: 'refined transcript',
    },
    context: { draftChars: 4, recentMessageCount: 2, recentMessageChars: 20, learnedTermCount: 1 },
    asrKind: 'openai-transcription',
    asrModel: 'whisper-small',
    refineKind: 'openai-chat',
    refineModel: 'qwen-small',
    ...overrides,
  }
}
