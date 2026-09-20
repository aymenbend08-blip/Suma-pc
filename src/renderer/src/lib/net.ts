/** Shared network-vs-business-error heuristic — same regex used by the
 * checkout flow and the sync engine, so both agree on what counts as
 * "offline" rather than "the server rejected this". */
export function isNetworkError(message: string): boolean {
  return /fetch|network|failed to fetch|timeout|ERR_/i.test(message);
}

function isDeviceOnlineNow(): boolean {
  // No `navigator` outside a browser/renderer context (e.g. this file's
  // own Vitest run, which uses the `node` environment) — default to
  // "online" there so callers see the exact same behavior as before this
  // was added, unless a test explicitly overrides it.
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

/**
 * True when a failed Supabase call should fall back to the local SQLite
 * cache instead of surfacing as a real error: either the failure is
 * network-shaped (`isNetworkError`), or the OS reports no network
 * interface at all. The second case matters for a genuinely offline
 * device with an expired access token — supabase-js can reject a call
 * client-side ("JWT expired", "Auth session missing", a 401 synthesized
 * without ever reaching the network) without the message looking
 * network-shaped. Gating on `navigator.onLine` (not on the error text)
 * keeps this from becoming a blanket "ignore every 401" hack: a genuine
 * rejection that happens while the device actually has a connection is
 * never treated as offline by this function.
 */
export function isOfflineFallbackEligible(
  message: string,
  deviceOnline: boolean = isDeviceOnlineNow(),
): boolean {
  return isNetworkError(message) || !deviceOnline;
}

type MaybeError = { message: string } | null | undefined;

/**
 * Combines the stores + store_members fetch results from a single
 * startup load into one decision: fall back to the cached local mirror
 * (covers both "really offline" and "offline with an expired token"),
 * or surface whichever error came back — never silently drop to an
 * empty membership list just because only one of the two queries failed.
 */
export function decideStoreLoad(
  storesError: MaybeError,
  membersError: MaybeError,
  deviceOnline: boolean = isDeviceOnlineNow(),
): { useCache: boolean; surfacedError: string | null } {
  const storesOffline = Boolean(storesError && isOfflineFallbackEligible(storesError.message, deviceOnline));
  const membersOffline = Boolean(membersError && isOfflineFallbackEligible(membersError.message, deviceOnline));

  if (storesOffline || membersOffline) {
    return { useCache: true, surfacedError: null };
  }

  const firstError = storesError ?? membersError;
  return { useCache: false, surfacedError: firstError ? firstError.message : null };
}

type StoredSessionLike = { access_token: string; refresh_token: string; user: unknown };

/**
 * supabase-js's own getSession() nulls out the session once an access
 * token has actually expired AND its background refresh attempt fails
 * (see auth-js's GoTrueClient.__loadSession) — even when that failure is
 * just "the device is offline", not a genuine, connected rejection of the
 * refresh token. supabase-js itself only wipes the stored session from
 * disk on a genuine (non-retryable) rejection — a real network failure
 * preserves it — so reading the raw storage entry back out recovers
 * exactly the cases getSession() shouldn't have discarded, and is
 * naturally a no-op for a genuine rejection (nothing left to recover).
 * No `@supabase/supabase-js` import here on purpose — keeps this module
 * (and its Vitest run) free of any browser/window dependency.
 */
export function parseStaleSession<T extends StoredSessionLike>(raw: string | null): T | null {
  try {
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<T> | null;
    if (!parsed?.access_token || !parsed.refresh_token || !parsed.user) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/** Same decision as `decideStoreLoad`, applied to AuthContext's initial
 * getSession() read: only fall back to the stale on-disk session when the
 * failure was offline-eligible, never on a genuine, connected rejection. */
export function decideAuthSession<T extends StoredSessionLike>(
  resolvedSession: T | null,
  error: { message: string } | null,
  staleSessionRaw: string | null,
  deviceOnline: boolean = isDeviceOnlineNow(),
): T | null {
  if (resolvedSession) return resolvedSession;
  if (error && isOfflineFallbackEligible(error.message, deviceOnline)) {
    return parseStaleSession<T>(staleSessionRaw);
  }
  return null;
}
