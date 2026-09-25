import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CloudOff, FileText, Pencil, Plus, Search, UserPlus, Users, Wallet } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { localDb } from "@/lib/localdb";
import { isOfflineFallbackEligible } from "@/lib/net";
import { useStore } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";
import {
  clampPage,
  CUSTOMER_FILTERS,
  filterCustomersLocal,
  friendlyCustomerError,
  overdueCutoffIso,
  pageRange,
  paginateLocal,
  resolveOverdueDays,
  sanitizeCustomerSearch,
  type CustomerFilter,
} from "@/lib/customerList";
import type { CustomerRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { CreditBadge, CustomerAvatar, LoadingRows, Pager, PointsBadge } from "@/components/customers/shared";
import { CustomerPayDialog, type CustomerPaymentResult } from "@/components/customers/CustomerPayDialog";
import { CustomerFormDialog } from "@/components/customers/CustomerFormDialog";
import { CustomerPointsDialog } from "@/components/customers/CustomerPointsDialog";
import { CustomerRequestsTab } from "@/components/customers/CustomerRequestsTab";
import { CustomerProfile } from "@/components/customers/CustomerProfile";

const PAGE_SIZE = 25;

type ListSource = "server" | "local";

/**
 * Customers (Phase B — parity with SUMA Web). Online, the list is a
 * paginated, server-filtered read of `customers`; offline it falls back to
 * the local SQLite mirror with the same filters applied client-side.
 * Every write goes through a SECURITY DEFINER RPC (create/update/decide/
 * pay/adjust points) — the customers table itself is never written from
 * here, so balances can only move through their own audited paths.
 */
export function CustomersPage({ debtOnly = false }: { debtOnly?: boolean }) {
  const { active } = useStore();
  // Keyed on the store so switching stores starts from a clean slate.
  return <CustomersScreen key={active!.id} debtOnly={debtOnly} />;
}

function CustomersScreen({ debtOnly }: { debtOnly: boolean }) {
  const { active, perms } = useStore();
  const { isOnline, syncNow } = useSync();
  const storeId = active!.id;
  const overdueDays = resolveOverdueDays(active!.credit_overdue_days);

  const [tab, setTab] = useState("customers");
  const [pendingCount, setPendingCount] = useState<number | null>(null);

  const [filter, setFilter] = useState<CustomerFilter>(debtOnly ? "debt" : "all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const searchRef = useRef("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [source, setSource] = useState<ListSource>(isOnline ? "server" : "local");
  const [listVersion, setListVersion] = useState(0);
  const requestSeq = useRef(0);

  const [payTarget, setPayTarget] = useState<CustomerRow | null>(null);
  const [formTarget, setFormTarget] = useState<CustomerRow | "new" | null>(null);
  const [pointsTarget, setPointsTarget] = useState<CustomerRow | null>(null);
  const [profile, setProfile] = useState<CustomerRow | null>(null);
  const [profileReloadKey, setProfileReloadKey] = useState(0);

  const offline = !isOnline || source === "local";

  // Home's "تسديد ديون" tile re-targets an already-open page.
  const firstDebtOnly = useRef(true);
  useEffect(() => {
    if (firstDebtOnly.current) {
      firstDebtOnly.current = false;
      return;
    }
    setFilter(debtOnly ? "debt" : "all");
    setPage(0);
    setTab("customers");
  }, [debtOnly]);

  useEffect(() => {
    const t = setTimeout(() => {
      const next = sanitizeCustomerSearch(searchInput);
      if (next === searchRef.current) return;
      searchRef.current = next;
      setSearch(next);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  async function loadList() {
    const seq = ++requestSeq.current;
    setLoading(true);
    setListError(null);

    if (isOnline) {
      const { from, to } = pageRange(page, PAGE_SIZE);
      let q = supabase
        .from("customers")
        .select("*", { count: "exact" })
        .eq("store_id", storeId)
        .eq("status", "approved");
      if (search) q = q.or(`full_name.ilike.%${search}%,phone.ilike.%${search}%`);
      if (filter === "debt") q = q.gt("credit_balance", 0);
      else if (filter === "credit") q = q.lt("credit_balance", 0);
      else if (filter === "overdue") q = q.gt("credit_balance", 0).lte("credit_since", overdueCutoffIso(overdueDays));
      const { data, error, count } = await q
        .order("full_name", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      if (seq !== requestSeq.current) return;

      if (!error) {
        const totalCount = count ?? 0;
        const clamped = clampPage(page, totalCount, PAGE_SIZE);
        if (clamped !== page) {
          setPage(clamped); // e.g. the last page emptied — the effect reloads
          return;
        }
        setSource("server");
        setRows(data ?? []);
        setTotal(totalCount);
        setLoading(false);
        return;
      }
      if (!isOfflineFallbackEligible(error.message)) {
        setLoading(false);
        setListError(friendlyCustomerError(error.message));
        return;
      }
      // Network-shaped failure: fall through to the local mirror.
    }

    try {
      const all = await localDb.listCustomers(storeId);
      if (seq !== requestSeq.current) return;
      const filtered = filterCustomersLocal(all, { term: search, filter, overdueDays });
      const slice = paginateLocal(filtered, page, PAGE_SIZE);
      setSource("local");
      setRows(slice.rows);
      setTotal(filtered.length);
      if (slice.page !== page) setPage(slice.page);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setListError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  }

  useEffect(() => {
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, isOnline, filter, search, page, listVersion]);

  // Pending-requests badge (the requests tab keeps it current afterwards).
  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    void supabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("status", "pending")
      .then(({ count, error }) => {
        if (!cancelled && !error) setPendingCount(count ?? 0);
      });
    return () => {
      cancelled = true;
    };
  }, [storeId, isOnline]);

  /** Refresh the local SQLite mirror so POS's offline customer search sees
   * the change now, not on the next 30 s sync cycle. */
  function refreshMirror() {
    void syncNow();
  }

  function patchRow(row: CustomerRow) {
    setRows((prev) => prev.map((r) => (r.id === row.id ? row : r)));
    setProfile((p) => (p && p.id === row.id ? row : p));
  }

  function handlePaid(result: CustomerPaymentResult) {
    setPayTarget(null);
    if (result.updated) {
      patchRow(result.updated);
      refreshMirror();
    } else {
      // Offline: mirror the same delta the local DB just applied.
      const apply = (r: CustomerRow): CustomerRow =>
        r.id === result.customerId ? { ...r, credit_balance: Number(r.credit_balance) - result.amount } : r;
      setRows((prev) => prev.map(apply));
      setProfile((p) => (p ? apply(p) : p));
    }
    setProfileReloadKey((k) => k + 1);
  }

  function handleSaved(row: CustomerRow, created: boolean) {
    setFormTarget(null);
    if (created) {
      // Narrow the list to the new customer's phone so it is visible right
      // away whatever page/filter was active — one small page query.
      const term = sanitizeCustomerSearch(row.phone);
      searchRef.current = term;
      setSearchInput(row.phone);
      setSearch(term);
      setFilter("all");
      setPage(0);
      setTab("customers");
      setListVersion((v) => v + 1);
    } else {
      patchRow(row);
    }
    refreshMirror();
  }

  function handlePointsDone(row: CustomerRow) {
    setPointsTarget(null);
    patchRow(row);
    setProfileReloadKey((k) => k + 1);
    refreshMirror();
  }

  function handleDecided(_row: CustomerRow, approved: boolean) {
    if (approved) {
      setListVersion((v) => v + 1);
      refreshMirror();
    }
  }

  return (
    <>
      <div className="space-y-3 print:hidden">
        <div className="surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
              <Users className="size-4" aria-hidden />
            </span>
            <h1 className="text-lg font-bold">{debtOnly ? "تسديد ديون الزبائن" : "الزبائن"}</h1>
            <Button
              size="sm"
              className="ms-auto"
              disabled={offline}
              title={offline ? "إضافة زبون تحتاج اتصالاً بالإنترنت" : undefined}
              onClick={() => setFormTarget("new")}
            >
              <Plus className="size-3.5" aria-hidden />
              زبون جديد
            </Button>
          </div>
        </div>

        {offline && (
          <div className="surface flex items-center gap-2 border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-xs">
            <CloudOff className="size-4 shrink-0 text-[var(--warning-foreground)]" aria-hidden />
            <p>
              غير متصل — القائمة من النسخة المحلية وقد لا تكون محدّثة. تسديد الديون يعمل ويُزامَن تلقائيًا؛ إضافة
              وتعديل الزبائن، الطلبات، كشف الحساب والنقاط تحتاج اتصالاً بالإنترنت.
            </p>
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab} dir="rtl">
          <TabsList>
            <TabsTrigger value="customers">الزبائن</TabsTrigger>
            <TabsTrigger value="requests" className="gap-1.5">
              <UserPlus className="size-3.5" aria-hidden />
              طلبات قيد التأكيد
              {pendingCount !== null && pendingCount > 0 && (
                <span className="rounded-full bg-[var(--destructive)] px-1.5 text-[10px] font-bold text-white num">
                  {pendingCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* Kept mounted so search/filter/page survive a trip to the requests tab. */}
          <TabsContent value="customers" forceMount className="space-y-3 data-[state=inactive]:hidden">
            <div className="surface flex flex-wrap items-center gap-3 p-3">
              <div className="relative min-w-56 flex-1">
                <Search
                  className="pointer-events-none absolute top-1/2 end-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="بحث بالاسم أو الهاتف..."
                  className="pe-9"
                />
              </div>
              <div className="flex gap-2 overflow-x-auto">
                {CUSTOMER_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => {
                      setFilter(f.key);
                      setPage(0);
                    }}
                    className={
                      filter === f.key
                        ? "shrink-0 rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-bold text-[var(--primary-foreground)]"
                        : "shrink-0 rounded-full bg-[var(--muted)] px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-[var(--accent)]/20"
                    }
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="surface overflow-hidden p-0">
              {loading && rows.length === 0 ? (
                <LoadingRows />
              ) : listError ? (
                <div className="flex flex-col items-center gap-2 py-10 text-sm">
                  <p className="text-destructive">{listError}</p>
                  <Button variant="outline" size="sm" onClick={() => void loadList()}>
                    إعادة المحاولة
                  </Button>
                </div>
              ) : rows.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {search || filter !== "all" ? "لا يوجد زبائن مطابقون." : "ما كاين زبائن بعد."}
                </p>
              ) : (
                <table className={cn("w-full text-sm transition-opacity", loading && "opacity-60")}>
                  <thead>
                    <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
                      <th className="px-3 py-2 text-start font-bold">الاسم</th>
                      <th className="px-3 py-2 text-start font-bold">الهاتف</th>
                      <th className="w-24 px-3 py-2 text-center font-bold">النقاط</th>
                      <th className="w-44 px-3 py-2 text-center font-bold">الرصيد</th>
                      <th className="w-72 px-3 py-2 text-center font-bold">إجراء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c, i) => (
                      <tr
                        key={c.id}
                        className={`border-b border-border transition-colors last:border-0 hover:bg-[var(--accent)]/10 ${i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"}`}
                      >
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            className="flex items-center gap-2.5 text-start hover:underline"
                            onClick={() => setProfile(c)}
                          >
                            <CustomerAvatar name={c.full_name} />
                            <span className="font-medium">{c.full_name}</span>
                          </button>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground num" dir="ltr">
                          {c.phone}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <PointsBadge points={c.points_balance} />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <CreditBadge balance={c.credit_balance} creditSince={c.credit_since} overdueDays={overdueDays} />
                          {Number(c.credit_balance) === 0 && <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1">
                            {Number(c.credit_balance) > 0 && (
                              <Button variant="outline" size="sm" onClick={() => setPayTarget(c)}>
                                <Wallet className="size-3.5" aria-hidden />
                                تسديد
                              </Button>
                            )}
                            <Button variant="outline" size="sm" onClick={() => setProfile(c)}>
                              <FileText className="size-3.5" aria-hidden />
                              ملف الزبون
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              disabled={offline}
                              title={offline ? "التعديل يحتاج اتصالاً بالإنترنت" : "تعديل"}
                              aria-label="تعديل"
                              onClick={() => setFormTarget(c)}
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} disabled={loading} />
            </div>
          </TabsContent>

          <TabsContent value="requests">
            <CustomerRequestsTab
              storeId={storeId}
              isOnline={isOnline}
              onCount={setPendingCount}
              onDecided={handleDecided}
            />
          </TabsContent>
        </Tabs>
      </div>

      {profile && (
        <CustomerProfile
          customer={profile}
          storeId={storeId}
          isOnline={!offline}
          overdueDays={overdueDays}
          reloadKey={profileReloadKey}
          onClose={() => setProfile(null)}
          onPay={() => setPayTarget(profile)}
          onEdit={() => setFormTarget(profile)}
          onPoints={() => setPointsTarget(profile)}
          onCustomerRefreshed={patchRow}
        />
      )}

      {payTarget && (
        <CustomerPayDialog
          customer={payTarget}
          storeId={storeId}
          onClose={() => setPayTarget(null)}
          onPaid={handlePaid}
        />
      )}

      {formTarget && (
        <CustomerFormDialog
          storeId={storeId}
          customer={formTarget === "new" ? null : formTarget}
          onClose={() => setFormTarget(null)}
          onSaved={handleSaved}
        />
      )}

      {pointsTarget && perms.canManageCustomers && (
        <CustomerPointsDialog
          customer={pointsTarget}
          storeId={storeId}
          onClose={() => setPointsTarget(null)}
          onDone={handlePointsDone}
        />
      )}
    </>
  );
}
