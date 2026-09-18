import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'ids',
    include: ['test/**/*.test.ts'],
  },
});
