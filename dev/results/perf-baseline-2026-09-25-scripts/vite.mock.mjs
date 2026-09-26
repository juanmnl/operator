import { defineConfig } from '/Users/juanmnl/Developer/operator/node_modules/vite/dist/node/index.js'
import react from '/Users/juanmnl/Developer/operator/node_modules/@vitejs/plugin-react/dist/index.js'
import tailwindcss from '/Users/juanmnl/Developer/operator/node_modules/@tailwindcss/vite/dist/index.mjs'
const min = process.env.MIN !== '0'
export default defineConfig({
  root: '/Users/juanmnl/Developer/operator', base: './', clearScreen: false,
  plugins: [react(), tailwindcss()],
  build: { outDir: process.env.OUT, emptyOutDir: true, minify: min, sourcemap: false,
    rollupOptions: { input: { mock: '/Users/juanmnl/Developer/operator/dev/mock.html' } } },
})
