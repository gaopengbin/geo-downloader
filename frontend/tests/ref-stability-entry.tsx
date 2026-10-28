import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initializeI18n } from '@/i18n'
import Fixture from './ref-stability'
import '@/index.css'

await initializeI18n()
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
