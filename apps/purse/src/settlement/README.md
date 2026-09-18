# Settlement engine

`settle(input)` (spec 4.4) turns a contest's escrowed pool, its entrants' scores, a prize
structure and a tie-break rule into one payout per entrant. It is a pure function: no
database, no clock, no randomness, and the same input produces the same output byte for
byte whatever order the entrants arrive in. `test/settlement/` holds it to that with
`fast-check`: conservation, non-negativity, placement monotonicity, determinism under
permutation and the remainder allocation are all properties over generated contests, not
examples.

`previewSettlement` and `closeContest` (`src/contests/settlement.ts`) both call `settle`
and hash the result with `payoutHash`; the preview returns the hash and the close requires
it, so a preview an operator has looked at is exactly what a close will pay or the close is
refused.

## The rounding rule

Every share is computed with floor division in `bigint`. Whatever the floors leave over is
handed out one minor unit at a time in descending placement order, meaning the best
placement first, then the next, and so on; within a tie group, by ascending `userId`.
Nothing is ever lost.

100 points split three ways under `top_n_equal` (or any equal split) is **34 / 33 / 33**:
each share floors to 33, the one leftover unit goes to first place. Never 33 / 33 / 33
with a unit missing.

The same rule applies to a `percentage_split` of `[50, 30, 20]` over 101 points:
50.5 → 50, 30.3 → 30, 20.2 → 20, and the leftover unit goes to first place: **51 / 30 / 20**.

## Structures, ties and edge cases

- `winner_take_all`, `placement_table` (explicit amounts or percentages, treated as
  weights so the pool is always paid out exactly), `percentage_split`, `top_n_equal` and
  `guaranteed_minimum` (a floor per placement, then the remainder by percentage; a pool that
  cannot cover the floors honours them best placement first).
- Ties are explicit: `split_evenly` shares the combined prize of the tied placements,
  `higher_seed_wins` prefers the lower seed number, `earliest_submission_wins` prefers the
  earlier counting score; a tie the rule cannot separate is shared.
- Unscored entrants place last, together, and receive nothing unless the structure defines
  a `participationFloor`.
- Zero entrants settle to nothing; a single entrant in a `winner_take_all` receives the
  whole escrow, which is their own entry back; a contest in which nobody scored splits the
  pool evenly, because nobody can be ranked.

The full rule set, with the reasoning, is in the header of `settle.ts`. The README at the
repository root repeats the rounding rule in its "How a score becomes a payout" section.
