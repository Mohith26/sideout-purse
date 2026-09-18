import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'logger',
    include: ['test/**/*.test.ts'],
  },
});
