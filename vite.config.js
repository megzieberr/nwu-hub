import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base must match the GitHub Pages project path (megzieberr.github.io/nwu-hub/)
export default defineConfig({
  plugins: [react()],
  base: '/nwu-hub/',
  server: { port: 5180 },
})
