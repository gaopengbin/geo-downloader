import { mergeConfig } from 'vite'
import base from '../vite.config'
export default mergeConfig(base, {
  server: {
    port: 1433,
    proxy: {
      '/__foundation_qa': {
        target: 'http://127.0.0.1:1434',
        rewrite: (path: string) => path.replace('/__foundation_qa', ''),
      },
    },
  },
})
