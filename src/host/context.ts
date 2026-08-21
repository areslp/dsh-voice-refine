import { MAX_CONTEXT_CHARS, MAX_CONTEXT_MESSAGES, MAX_DRAFT_CHARS } from '../shared/protocol.js'
import type { ConversationExcerpt } from '../shared/protocol.js'

export interface LearnedTerm {
  readonly from: string
  readonly to: string
}

export interface RefinementContext {
  readonly draft: string
  readonly messages: readonly ConversationExcerpt[]
  readonly learnedTerms: readonly LearnedTerm[]
}

export function buildRefinementContext(input: {
  readonly draft?: string
  readonly messages?: readonly ConversationExcerpt[]
  readonly learnedTerms?: readonly LearnedTerm[]
}): RefinementContext {
  const draft = trimToLast(input.draft ?? '', MAX_DRAFT_CHARS)
  const messages = (input.messages ?? [])
    .slice(-MAX_CONTEXT_MESSAGES)
    .map(message => ({ role: message.role, content: message.content.trim() }))
    .filter(message => message.content !== '')
  const budgetedMessages = trimMessagesToBudget(messages, MAX_CONTEXT_CHARS - draft.length)
  const learnedTerms = (input.learnedTerms ?? [])
    .filter(term => term.from.trim() !== '' && term.to.trim() !== '')
    .slice(0, 100)
    .map(term => ({ from: trimToLast(term.from, 96), to: trimToLast(term.to, 96) }))
  return { draft, messages: budgetedMessages, learnedTerms }
}

function trimMessagesToBudget(messages: readonly ConversationExcerpt[], budget: number): ConversationExcerpt[] {
  let remaining = Math.max(0, budget)
  const kept: ConversationExcerpt[] = []
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    const content = trimToLast(message.content, remaining)
    if (content !== '') {
      kept.push({ role: message.role, content })
      remaining -= content.length
    }
  }
  return kept.reverse()
}

export function trimToLast(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  return value.slice(value.length - maximum)
}
