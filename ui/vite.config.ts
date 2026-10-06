import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    // Dev server against a running backend; API=http://host:port when 8080 is taken.
    proxy: { '/api': { target: process.env.API ?? 'http://localhost:8080', ws: true } },
  },
});
