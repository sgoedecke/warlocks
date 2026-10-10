import { defineConfig } from 'vite';

export default defineConfig({
  build: { chunkSizeWarningLimit: 1000 },
  optimizeDeps: {
    include: ['mdx-m3-viewer/dist/cjs/parsers/blp/image', 'mdx-m3-viewer/dist/cjs/parsers/mdlx/model'],
  },
});
