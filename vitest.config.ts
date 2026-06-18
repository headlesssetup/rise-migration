import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing';

// WxtVitest wires up WXT's path aliases (`@/…`) and extension API mocks so the
// pure core/shared modules can be unit-tested directly.
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'node',
    include: ['core/**/*.test.ts', 'shared/**/*.test.ts'],
  },
});
