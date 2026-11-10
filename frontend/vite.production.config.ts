import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The same archive components are compiled for the standalone Linux deployment.
// No development server, Sites mock identity or Cloudflare runtime is required.
export default defineConfig({
  root: fileURLToPath(new URL('./production', import.meta.url)),
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist-production', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
