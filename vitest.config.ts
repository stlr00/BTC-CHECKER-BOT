import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
  // SWC вместо esbuild: нужен emitDecoratorMetadata для DI Nest
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
