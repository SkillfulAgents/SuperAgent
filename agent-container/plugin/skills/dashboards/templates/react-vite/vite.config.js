import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { gamutDashboard } from './gamut-dashboard.js';

export default defineConfig({
  plugins: [react(), gamutDashboard()],
  build: {
    outDir: 'dist',
  },
});
