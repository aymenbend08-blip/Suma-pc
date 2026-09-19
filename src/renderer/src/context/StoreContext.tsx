import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
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
      if (storesRes.error) setError(storesRes.error.message);
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
