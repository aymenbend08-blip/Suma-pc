/** Shared network-vs-business-error heuristic — same regex used by the
 * checkout flow and the sync engine, so both agree on what counts as
 * "offline" rather than "the server rejected this". */
export function isNetworkError(message: string): boolean {
  return /fetch|network|failed to fetch|timeout|ERR_/i.test(message);
}
