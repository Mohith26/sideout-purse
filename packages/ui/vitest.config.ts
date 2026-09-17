import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'ui',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
