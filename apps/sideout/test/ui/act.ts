import { act } from '@testing-library/react';

/**
 * Run a synchronous DOM interaction (a click, a fake SDK event) inside React's `act` and
 * let the promises it started settle (a fetch double resolving, a state update after it)
 * before the assertions that follow. One macrotask is enough for the doubles in these tests.
 */
export async function interact(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
