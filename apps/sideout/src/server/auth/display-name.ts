/**
 * The name a first sign-in gets when none was given. Display names appear on public
 * pages (rosters, match views, donors), so the default derives from the opaque user id
 * and never from the phone number; the profile prompts the user to choose a real one.
 */
export function defaultDisplayName(userId: string): string {
  return `Player ${userId.slice(-4)}`;
}

export function isDefaultDisplayName(user: { id: string; displayName: string }): boolean {
  return user.displayName === defaultDisplayName(user.id);
}
