import { build } from 'vite'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
const outDir=resolve(process.argv[2]??'')
if(!process.argv[2]||existsSync(outDir))throw new Error('Pass a new output directory')
await build({configFile:resolve('vite.config.ts'),base:'./',build:{outDir,emptyOutDir:false,sourcemap:true,
  rollupOptions:{input:resolve('tests/esri-date-switch.html')}}})
