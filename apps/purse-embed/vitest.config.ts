import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'purse-embed',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
