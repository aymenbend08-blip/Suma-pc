import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Users, Wallet } from "lucide-react";
import { payCustomerCredit } from "@/lib/rpc";
import { localDb } from "@/lib/localdb";
import { isNetworkError } from "@/lib/net";
import { useStore } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";
import { formatDA } from "@/lib/format";
import { uuid } from "@/lib/uuid";
import type { CustomerRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Same pay_customer_credit() RPC SUMA Web uses — a payment amount, never
 * an absolute balance, so it's safe regardless of what else touches this
 * customer's account at the same time. Falls back to the same local
 * outbox as POS checkout when offline. */
export function CustomersPage({ debtOnly = false }: { debtOnly?: boolean }) {
  const { active } = useStore();
  const { refreshPending, isOnline } = useSync();
  const storeId = active!.id;

  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showDebtOnly, setShowDebtOnly] = useState(debtOnly);
  const [payTarget, setPayTarget] = useState<CustomerRow | null>(null);
  const [amount, setAmount] = useState("");
  const [paying, setPaying] = useState(false);
  // One id per payment attempt — reused unchanged across a manual retry
  // (still open dialog after a rejection) and across an offline retry via
  // sync_queue, so pay_customer_credit() can recognize a resend instead of
  // deducting twice. Only regenerated when a NEW payment attempt starts
  // (openPayDialog), same pattern as POSPage's checkout clientRequestId.
  const [clientRequestId, setClientRequestId] = useState(() => uuid());

  async function load() {
    setLoading(true);
    setCustomers(await localDb.listCustomers(storeId));
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  const filtered = customers
    .filter((c) => !showDebtOnly || Number(c.credit_balance) > 0)
    .filter((c) => {
      const term = search.trim().toLowerCase();
      if (!term) return true;
      return c.full_name.toLowerCase().includes(term) || c.phone.includes(term);
    });

  function initials(name: string): string {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
  }

  function openPayDialog(c: CustomerRow) {
    setPayTarget(c);
    setAmount("");
    setClientRequestId(uuid());
  }

  const paymentValue = Number(amount);
  // Only meaningful while offline: online, pay_customer_credit() is the
  // authoritative check and this locally-cached balance can be stale.
  const exceedsLocalBalance =
    !isOnline && payTarget !== null && paymentValue > 0 && paymentValue > Number(payTarget.credit_balance);

  async function submitPayment() {
    if (!payTarget) return;
    const value = Number(amount);
    if (!(value > 0)) {
      toast.error("المبلغ لازم يكون أكبر من صفر.");
      return;
    }
    if (exceedsLocalBalance) {
      toast.error("المبلغ أكبر من الدّين المعروف محليًا على هذا الزبون — انتظر الاتصال أو قلّل المبلغ.");
      return;
    }
    setPaying(true);
    const { error } = await payCustomerCredit({
      _customer_id: payTarget.id,
      _store_id: storeId,
      _amount: value,
      _client_request_id: clientRequestId,
    });

    if (!error) {
      setPaying(false);
      toast.success("تم تسجيل الدفعة");
      setPayTarget(null);
      setAmount("");
      void load();
      return;
    }

    if (!isNetworkError(error.message)) {
      setPaying(false);
      toast.error(error.message);
      return;
    }

    // Offline — apply the same delta locally and queue the real RPC call
    // for the sync engine, exactly like an offline sale. Same
    // clientRequestId as the failed online attempt above, so a synced
    // replay is recognized as the same payment if it actually reached the
    // server before the connection dropped.
    await localDb.applyLocalCreditPayment(payTarget.id, value);
    await localDb.enqueueOperation("pay_customer_credit", {
      _customer_id: payTarget.id,
      _store_id: storeId,
      _amount: value,
      _client_request_id: clientRequestId,
    });
    setPaying(false);
    toast.success("تم تسجيل الدفعة (بدون إنترنت) — ستُزامن تلقائيًا.");
    refreshPending();
    setPayTarget(null);
    setAmount("");
    void load();
  }

  return (
    <div className="surface p-4">
      <div className="mb-4 flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
          <Users className="size-4" aria-hidden />
        </span>
        <h1 className="text-lg font-bold">{showDebtOnly ? "تسديد ديون الزبائن" : "الزبائن"}</h1>
        <Button
          variant={showDebtOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setShowDebtOnly((v) => !v)}
        >
          {showDebtOnly ? "عرض الكل" : "المديونين فقط"}
        </Button>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="بحث بالاسم أو الهاتف..."
          className="ms-auto max-w-64"
        />
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">جاري التحميل...</p>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">ما كاين زبائن</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
              <th className="rounded-s-lg px-3 py-2 text-start font-bold">الاسم</th>
              <th className="px-3 py-2 text-start font-bold">الهاتف</th>
              <th className="w-24 px-3 py-2 text-center font-bold">النقاط</th>
              <th className="w-32 px-3 py-2 text-center font-bold">الدّين</th>
              <th className="w-28 rounded-e-lg px-3 py-2 text-center font-bold">إجراء</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c, i) => (
              <tr
                key={c.id}
                className={`border-b border-border transition-colors last:border-0 hover:bg-[var(--accent)]/10 ${i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"}`}
              >
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2.5">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--primary)]/10 text-[11px] font-bold text-[var(--primary)]">
                      {initials(c.full_name)}
                    </span>
                    <span className="font-medium">{c.full_name}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground num" dir="ltr">
                  {c.phone}
                </td>
                <td className="px-3 py-2 text-center text-xs text-muted-foreground num">{c.points_balance}</td>
                <td className={`px-3 py-2 text-center font-bold num ${Number(c.credit_balance) > 0 ? "text-destructive" : ""}`}>
                  {formatDA(c.credit_balance)}
                </td>
                <td className="px-3 py-2 text-center">
                  {Number(c.credit_balance) > 0 && (
                    <Button variant="outline" size="sm" onClick={() => openPayDialog(c)}>
                      <Wallet className="size-4" aria-hidden />
                      تسديد
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {payTarget && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setPayTarget(null)}>
          <div className="surface w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 font-bold">تسديد دفعة — {payTarget.full_name}</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              الدّين الحالي: <span className="num">{formatDA(payTarget.credit_balance)}</span>
            </p>
            <Input
              type="number"
              min={0}
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="المبلغ المدفوع (دج)"
            />
            {exceedsLocalBalance && (
              <p className="mt-1.5 text-xs font-medium text-destructive">
                المبلغ أكبر من الدّين المعروف محليًا ({formatDA(payTarget.credit_balance)}) — بدون إنترنت لا يمكن
                تأكيد المبلغ الفعلي.
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setPayTarget(null)}>
                إلغاء
              </Button>
              <Button
                className="flex-1"
                disabled={paying || exceedsLocalBalance}
                onClick={() => void submitPayment()}
              >
                {paying && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {exceedsLocalBalance ? "المبلغ غير صالح محليًا" : "تأكيد"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
