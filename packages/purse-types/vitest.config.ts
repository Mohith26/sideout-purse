import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'purse-types',
    include: ['test/**/*.test.ts'],
  },
});
