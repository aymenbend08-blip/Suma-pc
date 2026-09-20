import { describe, expect, it } from "vitest";
import { decideAuthSession, decideStoreLoad, isNetworkError, isOfflineFallbackEligible, parseStaleSession } from "./net";

describe("isNetworkError", () => {
  it("matches the actual browser fetch-failure message", () => {
    // What Chromium's fetch() rejection looks like once postgrest-js
    // formats it as `${error.name}: ${error.message}` (verified against
    // the installed @supabase/postgrest-js source, see PostgrestBuilder.ts).
    expect(isNetworkError("TypeError: Failed to fetch")).toBe(true);
  });

  it("matches other network-shaped messages", () => {
    expect(isNetworkError("network request failed")).toBe(true);
    expect(isNetworkError("connection timeout")).toBe(true);
    expect(isNetworkError("net::ERR_CONNECTION_RESET")).toBe(true);
  });

  it("does not match record_sale()'s actual business-rejection messages", () => {
    // The real strings record_sale()/pay_customer_credit() raise
    // (supabase/migrations/20260919130000_record_sale_stock_check.sql and
    // 20260919000000_pay_customer_credit_idempotency.sql) — must never be
    // misclassified as a network failure, or a genuine rejection would
    // silently become an offline sale instead of being shown to the cashier.
    expect(isNetworkError("الكمية المطلوبة (5) أكبر من المخزون المتوفر (2.000) لـ حليب.")).toBe(false);
    expect(isNetworkError("المبلغ أكبر من الدّين المتبقي على هذا الزبون.")).toBe(false);
    expect(isNetworkError("ما عندكش صلاحية البيع في هذا المحل.")).toBe(false);
    expect(isNetworkError("الزبون غير موجود أو غير مؤكَّد.")).toBe(false);
  });
});

describe("isOfflineFallbackEligible", () => {
  it("stays eligible for plain network-shaped errors regardless of navigator.onLine", () => {
    expect(isOfflineFallbackEligible("TypeError: Failed to fetch", true)).toBe(true);
    expect(isOfflineFallbackEligible("TypeError: Failed to fetch", false)).toBe(true);
  });

  it("treats an auth-shaped error as offline-eligible when the device reports no connection", () => {
    // A genuinely offline device with an expired access token: supabase-js
    // can reject client-side ("JWT expired", 401, "Auth session missing")
    // without ever reaching the network, so the message itself doesn't
    // look network-shaped — but navigator.onLine === false means it can't
    // possibly be a genuine, connected rejection either.
    expect(isOfflineFallbackEligible("JWT expired", false)).toBe(true);
    expect(isOfflineFallbackEligible("Auth session missing!", false)).toBe(true);
    expect(isOfflineFallbackEligible("401: Unauthorized", false)).toBe(true);
  });

  it("does NOT treat an auth-shaped error as offline-eligible while genuinely connected", () => {
    // This is the explicit guard against a blanket "ignore every 401"
    // hack: the same auth error, but the device really does have a
    // connection, must surface as a real rejection, not silently become
    // an offline-cache fallback.
    expect(isOfflineFallbackEligible("JWT expired", true)).toBe(false);
    expect(isOfflineFallbackEligible("Auth session missing!", true)).toBe(false);
    expect(isOfflineFallbackEligible("401: Unauthorized", true)).toBe(false);
  });
});

describe("decideStoreLoad", () => {
  it("uses the cache when the stores query itself is a plain network failure", () => {
    const decision = decideStoreLoad({ message: "TypeError: Failed to fetch" }, null, true);
    expect(decision).toEqual({ useCache: true, surfacedError: null });
  });

  it("reaches the offline path on a genuinely offline device with an expired token (Bug 2 scenario)", () => {
    // Local data exists + no connection + expired access token + app
    // startup → both queries reject with auth-shaped messages, but
    // navigator.onLine is false, so the app must fall back to the local
    // cache (and from there reach Offline mode per locally stored
    // permissions) instead of surfacing a hard error.
    const decision = decideStoreLoad({ message: "JWT expired" }, { message: "JWT expired" }, false);
    expect(decision).toEqual({ useCache: true, surfacedError: null });
  });

  it("falls back to the cache when only store_members fails over the network, preserving permissions", () => {
    // Covers owner/manager/employee alike: whichever role's row lives in
    // the local cache is what gets used, since the fallback pulls the
    // whole cached membership list rather than dropping to [].
    const decision = decideStoreLoad(null, { message: "network request failed" }, true);
    expect(decision).toEqual({ useCache: true, surfacedError: null });
  });

  it("surfaces a genuine store_members error instead of silently emptying permissions (Bug 3 scenario)", () => {
    const decision = decideStoreLoad(
      null,
      { message: "permission denied for table store_members" },
      true,
    );
    expect(decision.useCache).toBe(false);
    expect(decision.surfacedError).toBe("permission denied for table store_members");
  });

  it("still surfaces a genuine stores error exactly as before, when connected", () => {
    const decision = decideStoreLoad({ message: "new row violates row-level security policy" }, null, true);
    expect(decision.useCache).toBe(false);
    expect(decision.surfacedError).toBe("new row violates row-level security policy");
  });

  it("proceeds normally with both results when neither query errors", () => {
    const decision = decideStoreLoad(null, null, true);
    expect(decision).toEqual({ useCache: false, surfacedError: null });
  });
});

const STALE_SESSION_RAW = JSON.stringify({
  access_token: "expired.access.token",
  refresh_token: "stale-refresh",
  expires_at: 1_000_000, // long past
  token_type: "bearer",
  user: { id: "owner-1", email: "owner@amal-store.dz" },
});

describe("parseStaleSession", () => {
  it("recovers a well-formed persisted session", () => {
    const session = parseStaleSession<{ access_token: string; refresh_token: string; user: { id: string } }>(
      STALE_SESSION_RAW,
    );
    expect(session?.user.id).toBe("owner-1");
  });

  it("returns null for missing, malformed, or incomplete storage", () => {
    expect(parseStaleSession(null)).toBeNull();
    expect(parseStaleSession("not json")).toBeNull();
    expect(parseStaleSession(JSON.stringify({ access_token: "x" }))).toBeNull(); // missing refresh_token/user
  });
});

describe("decideAuthSession", () => {
  it("keeps whatever getSession() resolved with when it actually returned a session", () => {
    const session = { access_token: "a", refresh_token: "b", user: {} };
    expect(decideAuthSession(session, null, STALE_SESSION_RAW, true)).toBe(session);
  });

  it("recovers the stale on-disk session on an offline-eligible failure (Bug 2 scenario)", () => {
    // Local data exists + no connection + expired access token + app
    // startup: getSession() resolved session:null (supabase-js discarded
    // it after a failed background refresh), but the device is offline,
    // so the app must still reach Offline mode using the locally stored
    // session/permissions rather than looking logged out.
    const result = decideAuthSession(null, { message: "AuthRetryableFetchError: Failed to fetch" }, STALE_SESSION_RAW, false);
    expect(result).not.toBeNull();
    expect((result as { user: { id: string } }).user.id).toBe("owner-1");
  });

  it("does NOT recover a session on a genuine, connected rejection", () => {
    // Mirrors reality: supabase-js itself wipes storage on a genuine
    // rejection, so there's nothing to recover — but this also guards the
    // decision function itself against ever doing so even if storage
    // happened to still hold something.
    const result = decideAuthSession(null, { message: "Invalid Refresh Token" }, STALE_SESSION_RAW, true);
    expect(result).toBeNull();
  });

  it("returns null when there's no error and no session (never logged in)", () => {
    expect(decideAuthSession(null, null, null, true)).toBeNull();
  });
});
