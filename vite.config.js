import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = process.env.PORT || env.PORT || '3000';

  return {
    root: 'client',
    plugins: [react()],
    build: {
      outDir: '../dist',
      emptyOutDir: true,
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${apiPort}`,
      },
    },
  };
});
