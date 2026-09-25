import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, CloudOff, Loader2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { decideCustomerRequest } from "@/lib/rpc";
import { clampPage, friendlyCustomerError, pageRange } from "@/lib/customerList";
import { formatDateTime } from "@/lib/format";
import type { CustomerRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { CustomerAvatar, CustomerModal, LoadingRows, Pager } from "./shared";

const REQUESTS_PAGE_SIZE = 50;

/**
 * Pending sign-up requests (customers.status = 'pending'), oldest first.
 * decide_customer_request() is terminal — a rejected phone can never
 * re-apply — so rejecting always goes through a confirmation step.
 */
export function CustomerRequestsTab({
  storeId,
  isOnline,
  onCount,
  onDecided,
}: {
  storeId: string;
  isOnline: boolean;
  onCount: (count: number) => void;
  onDecided: (row: CustomerRow, approved: boolean) => void;
}) {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmReject, setConfirmReject] = useState<CustomerRow | null>(null);
  const requestSeq = useRef(0);

  async function load(targetPage: number) {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    const { from, to } = pageRange(targetPage, REQUESTS_PAGE_SIZE);
    const { data, error, count } = await supabase
      .from("customers")
      .select("*", { count: "exact" })
      .eq("store_id", storeId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (seq !== requestSeq.current) return;
    setLoading(false);
    if (error) {
      setLoadError(friendlyCustomerError(error.message));
      return;
    }
    const totalCount = count ?? 0;
    // The last page emptied out (e.g. decisions elsewhere) — step back.
    if ((data ?? []).length === 0 && targetPage > 0 && totalCount > 0) {
      setPage(clampPage(targetPage, totalCount, REQUESTS_PAGE_SIZE));
      return;
    }
    setRows(data ?? []);
    setTotal(totalCount);
    onCount(totalCount);
  }

  useEffect(() => {
    if (!isOnline) {
      setLoading(false);
      return;
    }
    void load(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, page, isOnline]);

  async function decide(c: CustomerRow, approve: boolean) {
    if (busyId) return;
    setBusyId(c.id);
    const { data, error } = await decideCustomerRequest({ _customer_id: c.id, _store_id: storeId, _approve: approve });
    setBusyId(null);
    if (error) {
      toast.error(friendlyCustomerError(error.message));
      return;
    }
    setConfirmReject(null);
    toast.success(approve ? `تم قبول ${c.full_name}.` : "تم رفض الطلب.");
    const nextTotal = Math.max(0, total - 1);
    setRows((prev) => prev.filter((r) => r.id !== c.id));
    setTotal(nextTotal);
    onCount(nextTotal);
    onDecided(data ?? { ...c, status: approve ? "approved" : "rejected" }, approve);
    // Removing a row shifts the next page's first item onto this page;
    // refetch only when this page emptied or more rows are waiting.
    const pageEmptied = rows.length <= 1;
    const moreAfterThisPage = nextTotal >= (page + 1) * REQUESTS_PAGE_SIZE;
    if (pageEmptied || moreAfterThisPage) {
      const target = clampPage(page, nextTotal, REQUESTS_PAGE_SIZE);
      if (target !== page) setPage(target);
      else void load(page);
    }
  }

  if (!isOnline) {
    return (
      <div className="surface flex items-center gap-2 border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4 text-sm">
        <CloudOff className="size-4 shrink-0 text-[var(--warning-foreground)]" aria-hidden />
        طلبات الزبائن تحتاج اتصالاً بالإنترنت.
      </div>
    );
  }

  return (
    <div className="surface overflow-hidden p-0">
      {loading && rows.length === 0 ? (
        <LoadingRows />
      ) : loadError ? (
        <div className="flex flex-col items-center gap-2 py-10 text-sm">
          <p className="text-destructive">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => void load(page)}>
            إعادة المحاولة
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">ما كاين حتى طلب قيد التأكيد.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
              <th className="px-3 py-2 text-start font-bold">الاسم</th>
              <th className="px-3 py-2 text-start font-bold">الهاتف</th>
              <th className="px-3 py-2 text-start font-bold">تاريخ الطلب</th>
              <th className="w-48 px-3 py-2 text-center font-bold">إجراء</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr
                key={c.id}
                className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"}`}
              >
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2.5">
                    <CustomerAvatar name={c.full_name} />
                    <span className="font-medium">{c.full_name}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground num" dir="ltr">
                  {c.phone}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{formatDateTime(c.created_at)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-center gap-1.5">
                    <Button size="sm" disabled={busyId !== null} onClick={() => void decide(c, true)}>
                      {busyId === c.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
                      قبول
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive"
                      disabled={busyId !== null}
                      onClick={() => setConfirmReject(c)}
                    >
                      <X className="size-3.5" aria-hidden />
                      رفض
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {total > REQUESTS_PAGE_SIZE && (
        <Pager page={page} pageSize={REQUESTS_PAGE_SIZE} total={total} onPage={setPage} disabled={loading} />
      )}

      {confirmReject && (
        <CustomerModal title="رفض طلب الزبون" onClose={() => busyId === null && setConfirmReject(null)} className="max-w-md">
          <div className="mb-3 flex gap-2 rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <p>
              رفض طلب <span className="font-bold">{confirmReject.full_name}</span> (
              <span className="num" dir="ltr">
                {confirmReject.phone}
              </span>
              ) نهائي: لا يمكن التراجع عنه، ولن يستطيع هذا الرقم التسجيل من جديد في محلك.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" disabled={busyId !== null} onClick={() => setConfirmReject(null)}>
              إلغاء
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              disabled={busyId !== null}
              onClick={() => void decide(confirmReject, false)}
            >
              {busyId === confirmReject.id && <Loader2 className="size-4 animate-spin" aria-hidden />}
              رفض نهائي
            </Button>
          </div>
        </CustomerModal>
      )}
    </div>
  );
}
