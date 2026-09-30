import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    // Dev-Server gegen das laufende Backend
    proxy: { '/api': 'http://localhost:8080' },
  },
});
