import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Clock, Loader2, RotateCcw, X } from "lucide-react";
import { localDb, type SyncQueueItem } from "@/lib/localdb";
import { useSync } from "@/context/SyncContext";
import { formatDA } from "@/lib/format";
import { Button } from "@/components/ui/button";

/** Turns a queued operation's raw RPC payload into one readable line —
 * the same fields SUMA Web/PC send to record_sale()/pay_customer_credit(),
 * not a re-fetch of product/customer names (kept intentionally simple). */
function describeOperation(item: SyncQueueItem): string {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(item.payload) as Record<string, unknown>;
  } catch {
    return "بيانات العملية غير قابلة للقراءة.";
  }

  if (item.operation_type === "record_sale") {
    const items = Array.isArray(payload["_items"]) ? (payload["_items"] as unknown[]) : [];
    const methodLabel =
      payload["_payment_method"] === "credit"
        ? "دَين"
        : payload["_payment_method"] === "card"
          ? "بطاقة"
          : "نقدًا";
    return `بيع — ${items.length} صنف${items.length === 1 ? "" : "ات"} — الدفع ${methodLabel}${
      payload["_customer_id"] ? " — لزبون محدد" : ""
    }`;
  }
  if (item.operation_type === "pay_customer_credit") {
    const amount = Number(payload["_amount"] ?? 0);
    return `دفعة دَين — ${formatDA(amount)}`;
  }
  return `عملية غير معروفة: ${item.operation_type}`;
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ar-DZ", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

type RowProps = {
  item: SyncQueueItem;
  variant: "pending" | "failed";
  onRetry?: (id: string) => void;
  onDismiss?: (id: string) => void;
  busy?: boolean;
};

export function SyncQueueRow({ item, variant, onRetry, onDismiss, busy }: RowProps) {
  const isFailed = variant === "failed";
  return (
    <li className={`surface flex items-start gap-3 p-3 ${isFailed ? "border-destructive/40" : ""}`}>
      <div className={`mt-0.5 rounded-full p-1.5 ${isFailed ? "bg-destructive/15 text-destructive" : "bg-warning/20 text-warning"}`}>
        {isFailed ? <AlertTriangle className="size-4" aria-hidden /> : <Clock className="size-4" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{describeOperation(item)}</p>
        <p className="text-xs text-muted-foreground">{formatWhen(item.created_at)}</p>
        {isFailed && item.last_error && (
          <p className="mt-1 text-xs font-medium text-destructive">{item.last_error}</p>
        )}
        {!isFailed && item.retry_count > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">محاولات سابقة: {item.retry_count}</p>
        )}
      </div>
      {isFailed && (
        <div className="flex shrink-0 gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onRetry?.(item.id)}
            title="أعد المحاولة الآن"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RotateCcw className="size-3.5" aria-hidden />}
            إعادة المحاولة
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onDismiss?.(item.id)}
            title="تجاهل — تمت معالجتها يدويًا"
          >
            <X className="size-3.5" aria-hidden />
            تجاهل
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * The only place a permanently-rejected offline operation (insufficient
 * stock discovered at sync time, a deleted customer, etc.) is visible
 * anywhere in the app — previously a toast at the moment of failure and
 * nothing else. Failed items never disappear on their own; the owner
 * retries them (after fixing whatever caused the rejection) or
 * dismisses them once handled some other way.
 */
export function SyncQueuePage() {
  const { failedCount, refreshFailed, refreshPending, syncNow } = useSync();
  const [pending, setPending] = useState<SyncQueueItem[]>([]);
  const [failed, setFailed] = useState<SyncQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const [p, f] = await Promise.all([localDb.listPendingSync(), localDb.listFailedSync()]);
    setPending(p);
    setFailed(f);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, [failedCount]);

  async function handleRetry(id: string) {
    setBusyId(id);
    await localDb.retryFailedSync(id);
    await Promise.all([refreshFailed(), refreshPending()]);
    await load();
    setBusyId(null);
    toast.success("أُعيدت العملية لطابور المزامنة — ستُحاول عند الاتصال القادم.");
    void syncNow();
  }

  async function handleDismiss(id: string) {
    setBusyId(id);
    await localDb.dismissFailedSync(id);
    await refreshFailed();
    await load();
    setBusyId(null);
    toast.success("تم تجاهل العملية.");
  }

  return (
    <div className="space-y-4">
      <div className="surface p-4">
        <h1 className="text-lg font-bold">متابعة المزامنة</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          العمليات التي تمت بدون إنترنت وبانتظار المزامنة، والعمليات التي رفضها الخادم نهائيًا وتحتاج مراجعتك.
        </p>
      </div>

      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-destructive">
          <AlertTriangle className="size-4" aria-hidden />
          عمليات فشلت نهائيًا {failed.length > 0 && `(${failed.length})`}
        </h2>
        {loading ? (
          <p className="py-4 text-center text-sm text-muted-foreground">جاري التحميل...</p>
        ) : failed.length === 0 ? (
          <p className="surface flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Check className="size-4 text-success" aria-hidden />
            لا توجد عمليات فاشلة حاليًا.
          </p>
        ) : (
          <ul className="space-y-2">
            {failed.map((item) => (
              <SyncQueueRow
                key={item.id}
                item={item}
                variant="failed"
                onRetry={handleRetry}
                onDismiss={handleDismiss}
                busy={busyId === item.id}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-warning">
          <Clock className="size-4" aria-hidden />
          بانتظار الاتصال {pending.length > 0 && `(${pending.length})`}
        </h2>
        {!loading && pending.length === 0 ? (
          <p className="surface p-3 text-sm text-muted-foreground">لا توجد عمليات بانتظار المزامنة.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((item) => (
              <SyncQueueRow key={item.id} item={item} variant="pending" />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
