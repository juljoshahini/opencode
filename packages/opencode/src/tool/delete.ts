import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./delete.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { LSP } from "@/lsp/lsp"

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to delete (must be absolute, not relative)",
  }),
})

export const DeleteTool = Tool.define(
  "delete",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)
          if (!exists) {
            return {
              title: path.relative(instance.worktree, filepath),
              metadata: { filepath, existed: false },
              output: "File did not exist; nothing to delete.",
            }
          }

          const isFile = yield* fs.isFile(filepath)
          if (!isFile) {
            return yield* Effect.die(
              new Error(`Refusing to delete non-file path (directories not supported): ${filepath}`),
            )
          }

          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: { filepath, operation: "delete" },
          })

          yield* fs.remove(filepath)

          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: filepath,
            event: "unlink",
          })
          yield* lsp.touchFile(filepath, "document")

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: { filepath, existed: true },
            output: "Deleted file successfully.",
          }
        }).pipe(Effect.orDie),
    }
  }),
)
