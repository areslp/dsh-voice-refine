export const VOICE_CLIENT_STYLE_ID = 'dsh-voice-refine-client-styles'

export const VOICE_CLIENT_STYLES = `
.dsh-voice-refine { display: inline-flex; align-items: center; gap: 2px; position: relative; color: inherit; font: inherit; }
.dsh-voice-refine__button { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; touch-action: none; user-select: none; }
.dsh-voice-refine__button[aria-pressed="true"] { background: color-mix(in srgb, currentColor 14%, transparent); }
.dsh-voice-refine__button:disabled { cursor: not-allowed; opacity: .55; }
.dsh-voice-refine__icon { width: 17px; height: 17px; }
.dsh-voice-refine__sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.dsh-voice-refine__status { position: absolute; z-index: 3; right: 0; bottom: calc(100% + 6px); display: none; width: max-content; max-width: min(300px, 80vw); padding: 5px 8px; border-radius: 7px; background: Canvas; color: CanvasText; box-shadow: 0 3px 12px rgb(0 0 0 / 18%); font-size: .82em; }
.dsh-voice-refine__status[data-show="true"] { display: block; }
.dsh-voice-refine__settings { position: relative; }
.dsh-voice-refine__settings > summary { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 7px; cursor: pointer; list-style: none; opacity: .7; }
.dsh-voice-refine__settings > summary::-webkit-details-marker { display: none; }
.dsh-voice-refine__settings-panel { position: absolute; z-index: 4; top: calc(100% + 6px); right: 0; min-width: 230px; padding: 10px; border: 1px solid currentColor; border-radius: 8px; background: Canvas; color: CanvasText; box-shadow: 0 4px 16px rgb(0 0 0 / 18%); }
.dsh-voice-refine__settings-panel label { display: flex; align-items: center; gap: 6px; margin: 7px 0; }
.dsh-voice-refine__settings-panel input[type="text"] { width: 100%; box-sizing: border-box; }
.dsh-voice-refine__retry { margin-inline-start: 5px; }
`

export function ensureVoiceClientStyles(target?: Document): void {
  const documentTarget = target ?? (typeof document === 'undefined' ? undefined : document)
  if (documentTarget === undefined || documentTarget.getElementById(VOICE_CLIENT_STYLE_ID) !== null) return
  const style = documentTarget.createElement('style')
  style.id = VOICE_CLIENT_STYLE_ID
  style.textContent = VOICE_CLIENT_STYLES
  documentTarget.head.append(style)
}
