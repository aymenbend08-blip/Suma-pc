import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { payCustomerCredit } from "@/lib/rpc";
import { localDb } from "@/lib/localdb";
import { isNetworkError } from "@/lib/net";
import { useSync } from "@/context/SyncContext";
import { formatDA } from "@/lib/format";
import { uuid } from "@/lib/uuid";
import type { CustomerRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomerModal } from "./shared";

export type CustomerPaymentResult = {
  customerId: string;
  amount: number;
  /** The server's updated row when the RPC succeeded online; null when the
   * payment was applied to the local mirror and queued for sync. */
  updated: CustomerRow | null;
};

/** Same pay_customer_credit() RPC SUMA Web uses — a payment amount, never
 * an absolute balance, so it's safe regardless of what else touches this
 * customer's account at the same time. Falls back to the same local
 * outbox as POS checkout when offline. Mounted fresh for every payment
 * attempt (the parent unmounts it on close), so each attempt gets its own
 * clientRequestId. */
export function CustomerPayDialog({
  customer,
  storeId,
  onClose,
  onPaid,
}: {
  customer: CustomerRow;
  storeId: string;
  onClose: () => void;
  onPaid: (result: CustomerPaymentResult) => void;
}) {
  const { refreshPending, isOnline } = useSync();
  const [amount, setAmount] = useState("");
  const [paying, setPaying] = useState(false);
  // One id per payment attempt — reused unchanged across a manual retry
  // (still open dialog after a rejection) and across an offline retry via
  // sync_queue, so pay_customer_credit() can recognize a resend instead of
  // deducting twice. A NEW payment attempt mounts a new dialog and so gets
  // a new id — same pattern as POSPage's checkout clientRequestId.
  const [clientRequestId] = useState(() => uuid());

  const paymentValue = Number(amount);
  // Only meaningful while offline: online, pay_customer_credit() is the
  // authoritative check and this locally-cached balance can be stale.
  const exceedsLocalBalance =
    !isOnline && paymentValue > 0 && paymentValue > Number(customer.credit_balance);

  async function submitPayment() {
    if (paying) return;
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
    const { data, error } = await payCustomerCredit({
      _customer_id: customer.id,
      _store_id: storeId,
      _amount: value,
      _client_request_id: clientRequestId,
    });

    if (!error) {
      setPaying(false);
      toast.success("تم تسجيل الدفعة");
      onPaid({ customerId: customer.id, amount: value, updated: data ?? null });
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
    try {
      await localDb.applyLocalCreditPayment(customer.id, value);
      await localDb.enqueueOperation("pay_customer_credit", {
        _customer_id: customer.id,
        _store_id: storeId,
        _amount: value,
        _client_request_id: clientRequestId,
      });
    } catch (e) {
      setPaying(false);
      toast.error(e instanceof Error ? e.message : String(e));
      return;
    }
    setPaying(false);
    toast.success("تم تسجيل الدفعة (بدون إنترنت) — ستُزامن تلقائيًا.");
    refreshPending();
    onPaid({ customerId: customer.id, amount: value, updated: null });
  }

  return (
    <CustomerModal title={`تسديد دفعة — ${customer.full_name}`} onClose={onClose} zIndex="z-[60]">
      <p className="mb-3 text-sm text-muted-foreground">
        الدّين الحالي: <span className="num">{formatDA(customer.credit_balance)}</span>
      </p>
      <Input
        type="number"
        min={0}
        autoFocus
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void submitPayment()}
        placeholder="المبلغ المدفوع (دج)"
      />
      {exceedsLocalBalance && (
        <p className="mt-1.5 text-xs font-medium text-destructive">
          المبلغ أكبر من الدّين المعروف محليًا ({formatDA(customer.credit_balance)}) — بدون إنترنت لا يمكن تأكيد
          المبلغ الفعلي.
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onClose}>
          إلغاء
        </Button>
        <Button className="flex-1" disabled={paying || exceedsLocalBalance} onClick={() => void submitPayment()}>
          {paying && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {exceedsLocalBalance ? "المبلغ غير صالح محليًا" : "تأكيد"}
        </Button>
      </div>
    </CustomerModal>
  );
}
