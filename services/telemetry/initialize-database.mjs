import { initializeDatabase } from './database.mjs'

const args = process.argv.slice(2)
const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
try {
  const result = initializeDatabase({
    databasePath: value('--db'), databaseId: value('--database-id'), environment: value('--environment'),
    createNew: args.includes('--create-new'), offlineConfirmed: args.includes('--offline-confirmed'),
    expectedSha256: value('--expected-sha256'),
    expectedEventCount: value('--expected-events') === undefined ? undefined : Number(value('--expected-events')),
  })
  console.log(JSON.stringify(result))
} catch (error) { console.error(error.message); process.exitCode = 1 }
