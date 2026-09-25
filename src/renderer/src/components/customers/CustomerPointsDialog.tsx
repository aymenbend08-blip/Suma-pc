import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Minus, Plus } from "lucide-react";
import { adjustCustomerPoints } from "@/lib/rpc";
import { useStore } from "@/context/StoreContext";
import { availablePointsModes, POINTS_MODE_LABEL, validatePointsAdjustment, type PointsMode } from "@/lib/customerPoints";
import { uuid } from "@/lib/uuid";
import { friendlyCustomerError } from "@/lib/customerList";
import type { CustomerRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { CustomerModal } from "./shared";

/**
 * adjust_customer_points(): 'manual_adjust' (±, owner/manager only) or
 * 'redeem' (deduct only, also can_manage_customers). The ledger row is
 * written by a DB trigger. One client_request_id per dialog open — reused
 * on every retry from this same dialog so a resend never applies twice.
 */
export function CustomerPointsDialog({
  customer,
  storeId,
  onClose,
  onDone,
}: {
  customer: CustomerRow;
  storeId: string;
  onClose: () => void;
  onDone: (updated: CustomerRow) => void;
}) {
  const { perms } = useStore();
  const modes = availablePointsModes(perms);
  const [mode, setMode] = useState<PointsMode>(modes[0] ?? "redeem");
  const [direction, setDirection] = useState<"add" | "deduct">("add");
  const [amountText, setAmountText] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientRequestId] = useState(() => uuid());

  const balance = Number(customer.points_balance) || 0;

  async function submit() {
    if (saving) return;
    // Belt and braces: the RPC enforces this too.
    if (mode === "manual_adjust" && !perms.isAdmin) return;
    const v = validatePointsAdjustment({ mode, direction, amountText, balance, note });
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setError(null);
    setSaving(true);
    const { data, error: rpcError } = await adjustCustomerPoints({
      _customer_id: customer.id,
      _store_id: storeId,
      _delta: v.delta,
      _reason: mode,
      _notes: v.notes,
      _client_request_id: clientRequestId,
    });
    setSaving(false);
    if (rpcError || !data) {
      const message = rpcError ? friendlyCustomerError(rpcError.message) : "تعذر تعديل النقاط.";
      setError(message);
      toast.error(message);
      return;
    }
    toast.success(mode === "redeem" ? "تم استبدال النقاط." : "تم تعديل النقاط.");
    onDone(data);
  }

  if (modes.length === 0) return null;

  return (
    <CustomerModal title={`نقاط الوفاء — ${customer.full_name}`} onClose={onClose} zIndex="z-[60]" className="max-w-md">
      <p className="mb-3 text-sm text-muted-foreground">
        الرصيد الحالي: <span className="num font-bold text-foreground">{balance}</span> نقطة
      </p>

      {modes.length > 1 && (
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-[var(--muted)] p-1">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium transition-all",
                mode === m && "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-sm",
              )}
            >
              {POINTS_MODE_LABEL[m]}
            </button>
          ))}
        </div>
      )}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {mode === "manual_adjust" ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant={direction === "add" ? "default" : "outline"}
              className="flex-1"
              onClick={() => setDirection("add")}
            >
              <Plus className="size-4" aria-hidden />
              إضافة
            </Button>
            <Button
              type="button"
              variant={direction === "deduct" ? "destructive" : "outline"}
              className="flex-1"
              onClick={() => setDirection("deduct")}
            >
              <Minus className="size-4" aria-hidden />
              خصم
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">الاستبدال يخصم نقاطًا من رصيد الزبون مقابل هدية أو تخفيض.</p>
        )}

        <div>
          <Label htmlFor="pts-amount">عدد النقاط *</Label>
          <Input
            id="pts-amount"
            type="number"
            min={0}
            step="any"
            autoFocus
            dir="ltr"
            className="num"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="pts-note">{mode === "manual_adjust" ? "سبب التعديل *" : "ملاحظة"}</Label>
          <Input id="pts-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {error && <p className="text-xs font-medium text-destructive">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" className="flex-1" disabled={saving || (mode === "redeem" && balance <= 0)}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            تأكيد
          </Button>
        </div>
      </form>
    </CustomerModal>
  );
}
