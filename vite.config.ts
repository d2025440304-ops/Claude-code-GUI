import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // 代码分割：把体积大且相对独立的重依赖拆成独立 chunk，
        // 首屏只加载核心包，xterm / markdown 等在用到时按需加载
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search', '@xterm/addon-web-links', '@xterm/addon-clipboard'],
          'markdown': ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
})
