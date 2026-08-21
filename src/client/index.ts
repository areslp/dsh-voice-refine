import type { ComponentType } from 'react'
import { VoiceInput, type VoiceInputSlotProps } from './VoiceInput.js'

export * from './VoiceInput.js'
export * from './api.js'
export * from './context.js'
export * from './metadata.js'
export * from './mime.js'
export * from './preferences.js'
export * from './styles.js'

export const name = 'dsh-voice-refine'
export const inject = ['slots'] as const
export const VOICE_INPUT_SLOT = 'conversation.input.right'

export const VOICE_INPUT_REGISTRATION = {
  name: VOICE_INPUT_SLOT,
  id: 'dsh-voice-refine',
  order: 100,
  label: '语音输入 / Voice input',
} as const

export interface ClientSlots {
  inject(name: string, factory: () => unknown): unknown
  register<P>(options: Readonly<Record<string, unknown>>, component: ComponentType<P>): unknown
}

export interface ClientContext {
  readonly slots?: ClientSlots
  readonly effect?: (callback: () => unknown, key?: string) => unknown
}

export function registerClient(ctx: ClientContext & { readonly slots: ClientSlots }): unknown {
  return ctx.slots.inject(VOICE_INPUT_SLOT, () => ctx.slots.register(VOICE_INPUT_REGISTRATION, VoiceInput as ComponentType<VoiceInputSlotProps>))
}

export function apply(ctx: ClientContext): void {
  const register = (): unknown => {
    if (ctx.slots === undefined) throw new Error('dsh voice client slots are unavailable')
    return registerClient(ctx as ClientContext & { readonly slots: ClientSlots })
  }
  if (ctx.effect !== undefined) {
    ctx.effect(register, 'dsh-voice-refine: client slot')
  } else {
    register()
  }
}

export const registerVoiceClient = registerClient
export const registerVoiceInput = registerClient
