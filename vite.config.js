import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  server: { port: 7100, host: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        screener: resolve(__dirname, 'screener.html'),
        backtest: resolve(__dirname, 'backtest.html'),
        strategy: resolve(__dirname, 'strategy.html'),
      },
    },
  },
});
