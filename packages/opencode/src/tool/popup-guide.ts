import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import POPUP_GUIDE from "./popup-guide.txt"

export const Parameters = Schema.Struct({})

export const PopupGuideTool = Tool.define(
  "popup_guide",
  Effect.gen(function* () {
    return {
      description:
        "Returns the REQUIRED LanderLab spec for building popups, modals, overlays, lightboxes, or dialogs. You MUST call this BEFORE writing any popup/modal HTML — LanderLab popups use a proprietary data-popup-el structure plus the window.llPopupsApi runtime that your built-in modal knowledge does NOT match; a hand-rolled modal will not open or will render unstyled. Takes no arguments.",
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.succeed({
          title: "LanderLab popup authoring guide",
          output: POPUP_GUIDE,
          metadata: { truncated: false },
        }),
    }
  }),
)
