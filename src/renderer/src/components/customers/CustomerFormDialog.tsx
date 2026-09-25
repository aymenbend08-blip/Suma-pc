import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { createCustomer, updateCustomer } from "@/lib/rpc";
import { friendlyCustomerError, validateCustomerInput } from "@/lib/customerList";
import type { CustomerRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CustomerModal } from "./shared";

/**
 * New customer (create_customer) or name/phone edit (update_customer).
 * Both RPCs only ever write name/phone — never balances — which is why
 * the customers table itself is never written directly from here.
 * Online-only: the parent doesn't open this while offline.
 */
export function CustomerFormDialog({
  storeId,
  customer,
  onClose,
  onSaved,
}: {
  storeId: string;
  /** null = create a new customer */
  customer: CustomerRow | null;
  onClose: () => void;
  onSaved: (row: CustomerRow, created: boolean) => void;
}) {
  const [fullName, setFullName] = useState(customer?.full_name ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    const v = validateCustomerInput(fullName, phone);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    if (customer && v.fullName === customer.full_name && v.phone === customer.phone) {
      onClose();
      return;
    }
    setError(null);
    setSaving(true);
    const { data, error: rpcError } = customer
      ? await updateCustomer({ _customer_id: customer.id, _store_id: storeId, _full_name: v.fullName, _phone: v.phone })
      : await createCustomer({ _store_id: storeId, _full_name: v.fullName, _phone: v.phone });
    setSaving(false);
    if (rpcError || !data) {
      const message = rpcError ? friendlyCustomerError(rpcError.message) : "تعذر الحفظ.";
      setError(message);
      toast.error(message);
      return;
    }
    toast.success(customer ? "تم تحديث بيانات الزبون." : "تمت إضافة الزبون.");
    onSaved(data, !customer);
  }

  return (
    <CustomerModal title={customer ? "تعديل زبون" : "زبون جديد"} onClose={onClose} zIndex="z-[60]" className="max-w-md">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <Label htmlFor="cust-name">الاسم الكامل *</Label>
          <Input id="cust-name" autoFocus maxLength={120} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="cust-phone">رقم الهاتف *</Label>
          <Input
            id="cust-phone"
            dir="ltr"
            inputMode="tel"
            maxLength={30}
            className="num"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="0555xxxxxx"
          />
        </div>
        {error && <p className="text-xs font-medium text-destructive">{error}</p>}
        {!customer && (
          <p className="text-[11px] text-muted-foreground">
            الزبون يُضاف مؤكَّدًا مباشرة برصيد صفر — الدّين والنقاط تتحرك فقط عبر المبيعات والتسديدات.
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" className="flex-1" disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {customer ? "حفظ" : "إضافة"}
          </Button>
        </div>
      </form>
    </CustomerModal>
  );
}
