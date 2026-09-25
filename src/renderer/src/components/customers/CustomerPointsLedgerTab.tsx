import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { formatDateTime } from "@/lib/format";
import { clampPage, friendlyCustomerError, pageRange } from "@/lib/customerList";
import { formatPointsDelta, POINTS_REASON_LABEL } from "@/lib/customerPoints";
import { shortRef } from "@/lib/customerStatement";
import type { CustomerPointsLedgerRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LoadingRows, Pager } from "./shared";

const LEDGER_PAGE_SIZE = 25;

/** سجل النقاط — read-only view of customer_points_ledger (written only by
 * a DB trigger), newest first, 25 per page. */
export function CustomerPointsLedgerTab({
  customerId,
  storeId,
  reloadKey,
}: {
  customerId: string;
  storeId: string;
  reloadKey: number;
}) {
  const [rows, setRows] = useState<CustomerPointsLedgerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  async function load() {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    const { from, to } = pageRange(page, LEDGER_PAGE_SIZE);
    const { data, error, count } = await supabase
      .from("customer_points_ledger")
      .select("*", { count: "exact" })
      .eq("store_id", storeId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);
    if (seq !== requestSeq.current) return;
    setLoading(false);
    if (error) {
      setLoadError(friendlyCustomerError(error.message));
      return;
    }
    const totalCount = count ?? 0;
    const clamped = clampPage(page, totalCount, LEDGER_PAGE_SIZE);
    if (clamped !== page) {
      setPage(clamped);
      return;
    }
    setRows(data ?? []);
    setTotal(totalCount);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, storeId, page, reloadKey]);

  // A new adjustment lands on page 1 (newest first).
  useEffect(() => {
    setPage(0);
  }, [reloadKey]);

  return (
    <div className="surface overflow-hidden p-0">
      {loading && rows.length === 0 ? (
        <LoadingRows />
      ) : loadError ? (
        <div className="flex flex-col items-center gap-2 py-10 text-sm">
          <p className="text-destructive">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            إعادة المحاولة
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">ما كانش حركة نقاط بعد.</p>
      ) : (
        <div className={cn("overflow-x-auto transition-opacity", loading && "opacity-60")}>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
                <th className="px-3 py-2 text-start font-bold">التاريخ</th>
                <th className="px-3 py-2 text-start font-bold">السبب</th>
                <th className="px-3 py-2 text-center font-bold">التغيير</th>
                <th className="px-3 py-2 text-center font-bold">الرصيد بعد</th>
                <th className="px-3 py-2 text-start font-bold">المرجع</th>
                <th className="px-3 py-2 text-start font-bold">ملاحظات</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const delta = Number(r.delta);
                return (
                  <tr key={r.id} className={cn("border-b border-border last:border-0", i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white")}>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{formatDateTime(r.created_at)}</td>
                    <td className="px-3 py-2 text-xs font-medium">{POINTS_REASON_LABEL[r.reason] ?? r.reason}</td>
                    <td
                      className={cn(
                        "px-3 py-2 text-center font-bold num",
                        delta > 0 ? "text-[var(--success)]" : delta < 0 ? "text-destructive" : "",
                      )}
                    >
                      {formatPointsDelta(delta)}
                    </td>
                    <td className="px-3 py-2 text-center num">{Number(r.balance_after)}</td>
                    <td className="px-3 py-2 font-mono text-xs num" dir="ltr" title={r.reference_id ?? undefined}>
                      {r.reference_id ? shortRef(r.reference_id) : "—"}
                    </td>
                    <td className="max-w-56 truncate px-3 py-2 text-xs text-muted-foreground" title={r.notes ?? undefined}>
                      {r.notes || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total > LEDGER_PAGE_SIZE && (
        <Pager page={page} pageSize={LEDGER_PAGE_SIZE} total={total} onPage={setPage} disabled={loading} />
      )}
    </div>
  );
}
