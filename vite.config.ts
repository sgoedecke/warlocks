import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the build works from any path (e.g. GitHub Pages' /warlocks/).
  base: './',
  build: { chunkSizeWarningLimit: 1000 },
  optimizeDeps: {
    include: ['mdx-m3-viewer/dist/cjs/parsers/blp/image', 'mdx-m3-viewer/dist/cjs/parsers/mdlx/model'],
  },
});
