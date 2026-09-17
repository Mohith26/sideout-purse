import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'purse-sdk',
    include: ['test/**/*.test.ts'],
  },
});
