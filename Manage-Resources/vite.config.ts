import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the game also runs when hosted under the menu at games/manage-resources/
  base: './',
  plugins: [react(), tailwindcss()],
})
