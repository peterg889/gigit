/**
 * Ownership and marketplace capability are deliberately different.
 *
 * Historical profiles remain useful for old bookings and applications, but only
 * an active account's live profile may advertise a new marketplace action.
 */
export function accountCanAct(status: string | null | undefined): boolean {
  return status === "active";
}

export function liveProfileForActiveAccount<T extends { status: string }>(
  accountStatus: string | null | undefined,
  profile: T | null | undefined,
): T | null {
  return accountCanAct(accountStatus) && profile?.status === "live" ? profile : null;
}
