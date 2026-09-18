/** Round names, shared by the server read models and the client bracket. Pure. */
export function bracketRoundLabel(round: number, totalBracketRounds: number): string {
  const remaining = totalBracketRounds - round;
  if (remaining === 0) return 'Final';
  if (remaining === 1) return 'Semifinals';
  if (remaining === 2) return 'Quarterfinals';
  return `Round of ${2 ** (remaining + 1)}`;
}
