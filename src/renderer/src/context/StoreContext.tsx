import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { localDb } from "@/lib/localdb";
import { decideStoreLoad } from "@/lib/net";
import type { StoreMemberRow, StoreRow } from "@/lib/database.types";
import { useAuth } from "./AuthContext";

const ACTIVE_STORE_KEY = "suma_desktop.active_store";

export type StorePermissions = {
  role: "owner" | "manager" | "employee" | "none";
  isAdmin: boolean;
  canManageProducts: boolean;
  canUpdatePrice: boolean;
  canUsePos: boolean;
  canRefund: boolean;
  canManageCustomers: boolean;
};

type StoreState = {
  loading: boolean;
  error: string | null;
  /** True when stores/permissions came from the local SQLite cache
   * because Supabase wasn't reachable at all yet this session. */
  offlineFallback: boolean;
  stores: StoreRow[];
  active: StoreRow | null;
  select: (id: string) => void;
  perms: StorePermissions;
  userId: string | null;
  reload: () => void;
};

const StoreContext = createContext<StoreState | null>(null);

const NONE_PERMS: StorePermissions = {
  role: "none",
  isAdmin: false,
  canManageProducts: false,
  canUpdatePrice: false,
  canUsePos: false,
  canRefund: false,
  canManageCustomers: false,
};

/**
 * Mirrors SUMA Web's useOwnerStores()/getMyStores() exactly (same tables,
 * same permission formulas) but queries Supabase directly instead of
 * through a TanStack Start server function — Desktop has no server of its
 * own, so the authenticated Supabase client (RLS-scoped by the signed-in
 * user's JWT) plays that role directly.
 */
export function StoreProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;

  const [stores, setStores] = useState<StoreRow[]>([]);
  const [memberships, setMemberships] = useState<StoreMemberRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() =>
    window.localStorage.getItem(ACTIVE_STORE_KEY),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offlineFallback, setOfflineFallback] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!userId) {
      setStores([]);
      setMemberships([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const [storesRes, membersRes] = await Promise.all([
        supabase.from("stores").select("*").order("created_at", { ascending: true }),
        supabase
          .from("store_members")
          .select(
            "id, store_id, user_id, role, full_name, phone, can_update_price, can_manage_products, can_print_labels, is_active, created_at, updated_at, can_use_pos, can_refund, can_manage_customers",
          )
          .eq("user_id", userId),
      ]);
      if (cancelled) return;

      // A network-shaped failure on EITHER query here means we're offline
      // before any hydrate() cycle has ever primed the local SQLite mirror
      // this session — e.g. the app opened with no Wi-Fi yet, or with an
      // access token that expired while offline (which surfaces as an
      // auth-shaped error like "JWT expired" rather than a fetch failure,
      // but device.onLine being false still marks it offline-eligible —
      // see isOfflineFallbackEligible). Falling back to whatever was
      // cached from the LAST time this device was online lets the cashier
      // get into POS immediately instead of staring at an error screen; a
      // real rejection while genuinely connected still surfaces below.
      const decision = decideStoreLoad(storesRes.error, membersRes.error);
      if (decision.useCache) {
        const [localStores, localMembers] = await Promise.all([
          localDb.getStores(),
          localDb.getStoreMembers(userId),
        ]);
        if (cancelled) return;
        setOfflineFallback(true);
        setError(null);
        setStores(localStores);
        setMemberships(localMembers);
        setLoading(false);
        return;
      }

      // Neither error was offline-eligible: surface whichever one fired
      // (stores or members) instead of silently letting a failed
      // store_members fetch collapse permissions to an empty list — the
      // same treatment the stores error already got before this fix.
      setOfflineFallback(false);
      setError(decision.surfacedError);
      setStores(storesRes.data ?? []);
      setMemberships(membersRes.data ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, reloadTick]);

  const active = stores.find((s) => s.id === activeId) ?? stores[0] ?? null;

  const select = (id: string) => {
    window.localStorage.setItem(ACTIVE_STORE_KEY, id);
    setActiveId(id);
  };

  const membership = memberships.find((m) => m.store_id === active?.id) ?? null;
  const isOwner = Boolean(active && userId && active.owner_id === userId);

  const perms: StorePermissions = useMemo(() => {
    if (!active) return NONE_PERMS;
    const role: StorePermissions["role"] = isOwner ? "owner" : (membership?.role ?? "none");
    const isAdmin = role === "owner" || role === "manager";
    return {
      role,
      isAdmin,
      canManageProducts: isAdmin || Boolean(membership?.can_manage_products),
      // Pricing stays owner-only, same rule as can_update_price() server-side.
      canUpdatePrice: isOwner,
      canUsePos: isAdmin || Boolean(membership?.can_use_pos),
      canRefund: isAdmin || Boolean(membership?.can_refund),
      canManageCustomers: isAdmin || Boolean(membership?.can_manage_customers),
    };
  }, [active, isOwner, membership]);

  return (
    <StoreContext.Provider
      value={{
        loading,
        error,
        offlineFallback,
        stores,
        active,
        select,
        perms,
        userId,
        reload: () => setReloadTick((t) => t + 1),
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): StoreState {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}
