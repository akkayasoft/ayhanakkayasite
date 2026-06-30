import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Kademeli React gecisi: her "island" tek bir entry olarak derlenir ve
// olusan dosyalar Express'in servis ettigi src/public/dist altina yazilir.
// EJS sayfalari bu dosyalari <script type="module"> ile yukler.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../src/public/dist'),
    emptyOutDir: true,
    manifest: false,
    rollupOptions: {
      input: {
        'daily-board': resolve(__dirname, 'src/islands/dailyBoard.jsx')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
