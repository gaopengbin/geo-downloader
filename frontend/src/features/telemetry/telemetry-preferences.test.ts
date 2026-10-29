import test from'node:test'
import assert from'node:assert/strict'
import{resolveTelemetryPreference,TELEMETRY_NOTICE_VERSION}from'./telemetry-preferences.ts'
const now='2026-10-29T10:00:00.000Z'
test('fresh and never-decided clients report immediately with a pending disclosure',()=>{
 for(const saved of[undefined,{consent:'pending' as const,noticeVersion:4}]){const value=resolveTelemetryPreference(saved,now,()=> 'qa-install');assert.equal(value.consent,'enabled');assert.equal(value.consentedAt,now);assert.equal(value.noticeAcknowledgedVersion,null);assert.equal(value.installId,'qa-install')}
})
test('explicit opt-out survives upgrade without generating another identifier',()=>{
 const value=resolveTelemetryPreference({consent:'disabled',noticeVersion:1},now,()=>{throw Error('Must not create an ID')});assert.equal(value.consent,'disabled');assert.equal(value.installId,null)
})
test('upgrade retains installation identity but does not replay prior private tasks',()=>{
 const value=resolveTelemetryPreference({consent:'enabled',noticeVersion:4,consentedAt:'2026-10-01T00:00:00Z',installId:'same-install'},now,()=> 'new');assert.equal(value.installId,'same-install');assert.equal(value.consentedAt,now);assert.equal(value.noticeAcknowledgedVersion,null)
 const reopened=resolveTelemetryPreference({...value,noticeAcknowledgedVersion:TELEMETRY_NOTICE_VERSION},'2026-10-30T00:00:00Z',()=> 'new');assert.equal(reopened.consentedAt,now);assert.equal(reopened.noticeAcknowledgedVersion,TELEMETRY_NOTICE_VERSION)
})
