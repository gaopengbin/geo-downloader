/** Startup behavior is build-specific; it must never rewrite a user's consent. */
export function createRuntimePolicy(environment: { DEV?: boolean; MODE?: string; VITE_GEOD_VALIDATION?: string }) {
  const internalRun = environment.DEV === true
    || environment.MODE === 'test'
    || environment.MODE === 'validation'
    || environment.VITE_GEOD_VALIDATION === '1'
  return {
    automaticUpdateChecks: !internalRun,
    automaticOnboarding: !internalRun,
    telemetry: !internalRun,
  }
}

export const runtimePolicy = createRuntimePolicy(import.meta.env ?? {})
