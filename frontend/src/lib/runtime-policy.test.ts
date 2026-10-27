import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntimePolicy } from './runtime-policy.ts'

test('development and validation runs do not prompt, track, or check updates automatically', () => {
  for (const environment of [
    { DEV: true, MODE: 'development' },
    { DEV: true, MODE: 'production' },
    { DEV: false, MODE: 'test' },
    { DEV: false, MODE: 'validation' },
    { DEV: false, MODE: 'production', VITE_GEOD_VALIDATION: '1' },
  ]) {
    assert.deepEqual(createRuntimePolicy(environment), {
      automaticUpdateChecks: false, automaticOnboarding: false, telemetry: false,
    })
  }
})

test('normal production builds retain first-run consent, onboarding, and update checks', () => {
  for (const environment of [
    { DEV: false, MODE: 'production' },
    { DEV: false, MODE: 'production', VITE_GEOD_VALIDATION: '0' },
  ]) {
    assert.deepEqual(createRuntimePolicy(environment), {
      automaticUpdateChecks: true, automaticOnboarding: true, telemetry: true,
    })
  }
})
