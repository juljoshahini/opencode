// Tiny coordination primitive between start.ts (which owns the opencode
// subprocess) and sidecar.ts (which exposes the HTTP control endpoints).
// The worker is in charge of: pushing a state bundle, then telling us to
// spawn opencode. start.ts blocks on `waitForSpawnSignal()` until either
// the worker calls /__state/start or sidecar's auto-fallback fires.

let resolveSignal: (() => void) | null = null
const signalPromise = new Promise<void>((resolve) => {
  resolveSignal = resolve
})

let spawned = false

export function waitForSpawnSignal(): Promise<void> {
  return signalPromise
}

export function signalSpawn(): boolean {
  if (spawned) return false
  spawned = true
  resolveSignal?.()
  return true
}

export function hasSpawned(): boolean {
  return spawned
}
