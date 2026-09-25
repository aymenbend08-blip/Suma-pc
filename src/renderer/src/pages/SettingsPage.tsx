import { useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Settings as SettingsIcon } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useStore } from "@/context/StoreContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Store settings (Phase A item 9) — a form over columns that already
 * exist on `stores` (StoreRow already carries all of them; nothing new
 * added to the schema). This becomes the single source of truth POS
 * (tax/credit), receipt printing (footer/logo/QR toggle, item 1) and
 * reports already read from `useStore().active`, so saving here updates
 * every one of those the next time StoreContext reloads.
 *
 * Writes are owner-only server-side (`stores_admin_update`: qual is
 * `owner_id = auth.uid()`, confirmed live via pg_policies) — a manager
 * can be `perms.isAdmin` but still isn't the owner, so the form is
 * disabled (not just hidden) for anyone but the actual owner, matching
 * what Postgres would reject anyway.
 */
export function SettingsPage() {
  const { active, perms, reload } = useStore();
  const isOwner = perms.role === "owner";
  const store = active!;

  const [storeName, setStoreName] = useState(store.store_name);
  const [phone, setPhone] = useState(store.phone ?? "");
  const [address, setAddress] = useState(store.address ?? "");
  const [wilaya, setWilaya] = useState(store.wilaya ?? "");
  const [commune, setCommune] = useState(store.commune ?? "");
  const [logoUrl, setLogoUrl] = useState(store.logo_url ?? "");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [taxRate, setTaxRate] = useState(String(store.tax_rate ?? 0));
  const [receiptFooter, setReceiptFooter] = useState(store.receipt_footer ?? "");
  const [workingHours, setWorkingHours] = useState(store.working_hours ?? "");
  const [receiptShowQr, setReceiptShowQr] = useState(store.receipt_show_qr);
  const [creditLimit, setCreditLimit] = useState(String(store.credit_limit ?? 0));
  const [creditOverdueDays, setCreditOverdueDays] = useState(String(store.credit_overdue_days ?? 0));
  const [saving, setSaving] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  async function handleLogoFile(file: File) {
    if (!file.type.startsWith("image/")) return toast.error("لازم تختار صورة.");
    if (file.size > 3 * 1024 * 1024) return toast.error("الصورة كبيرة برشا (أقصى 3 ميغا).");
    setUploadingLogo(true);
    const ext = (file.name.split(".").pop() || "png").toLowerCase();
    const path = `${store.id}/logo-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("store-logos").upload(path, file, { upsert: true, contentType: file.type });
    setUploadingLogo(false);
    if (error) return toast.error(error.message || "تعذر رفع الشعار.");
    const { data } = supabase.storage.from("store-logos").getPublicUrl(path);
    setLogoUrl(data.publicUrl);
  }

  async function save() {
    if (!isOwner) return;
    const trimmedName = storeName.trim();
    if (!trimmedName) return toast.error("اسم المحل مطلوب.");
    const tax = Number(taxRate);
    if (!(tax >= 0 && tax <= 100)) return toast.error("نسبة الضريبة غير صالحة.");
    const limit = Number(creditLimit);
    if (!(limit >= 0)) return toast.error("سقف الدّين غير صالح.");
    const overdueDays = Number(creditOverdueDays);
    if (!(overdueDays >= 0)) return toast.error("عدد أيام التأخير غير صالح.");

    setSaving(true);
    const { error } = await supabase
      .from("stores")
      .update({
        store_name: trimmedName,
        phone: phone.trim() || null,
        address: address.trim() || null,
        wilaya: wilaya.trim() || null,
        commune: commune.trim() || null,
        logo_url: logoUrl.trim() || null,
        tax_rate: tax,
        receipt_footer: receiptFooter.trim() || null,
        working_hours: workingHours.trim() || null,
        receipt_show_qr: receiptShowQr,
        credit_limit: limit,
        credit_overdue_days: overdueDays,
      })
      .eq("id", store.id);
    setSaving(false);
    if (error) {
      toast.error(error.message.toLowerCase().includes("row-level security") ? "ما عندكش الصلاحية باش تدير هذا التغيير." : error.message);
      return;
    }
    toast.success("تم حفظ إعدادات المحل.");
    reload();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="grid size-9 place-items-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
          <SettingsIcon className="size-4.5" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-black tracking-tight">إعدادات المحل</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">تُستعمل في الفواتير والتقارير ونقطة البيع.</p>
        </div>
      </div>

      {!isOwner && (
        <div className="surface border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm text-[var(--warning-foreground)]">
          هذه الإعدادات متاحة لصاحب المحل فقط — يمكنك الاطلاع عليها لكن لا يمكنك الحفظ.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="surface overflow-hidden p-0">
          <h2 className="bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">معلومات المحل</h2>
          <div className="grid gap-3 p-4">
            <div className="flex items-center gap-3">
              <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed border-border bg-muted">
                {logoUrl ? <img src={logoUrl} alt="" className="size-full object-cover" /> : <span className="text-[9px] text-muted-foreground">بلا شعار</span>}
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={!isOwner}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleLogoFile(file);
                  }}
                />
                <Button type="button" variant="outline" size="sm" disabled={!isOwner || uploadingLogo} onClick={() => logoInputRef.current?.click()}>
                  {uploadingLogo ? "جاري الرفع..." : logoUrl ? "بدّل الشعار" : "ارفع شعار"}
                </Button>
              </div>
            </div>
            <div>
              <Label htmlFor="s-name">اسم المحل *</Label>
              <Input id="s-name" disabled={!isOwner} value={storeName} onChange={(e) => setStoreName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="s-phone">الهاتف</Label>
              <Input id="s-phone" disabled={!isOwner} dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="s-wilaya">الولاية</Label>
                <Input id="s-wilaya" disabled={!isOwner} value={wilaya} onChange={(e) => setWilaya(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="s-commune">البلدية</Label>
                <Input id="s-commune" disabled={!isOwner} value={commune} onChange={(e) => setCommune(e.target.value)} />
              </div>
            </div>
            <div>
              <Label htmlFor="s-address">العنوان</Label>
              <Input id="s-address" disabled={!isOwner} value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="s-hours">أوقات العمل</Label>
              <Input id="s-hours" disabled={!isOwner} value={workingHours} onChange={(e) => setWorkingHours(e.target.value)} placeholder="مثلًا: 8:00 - 22:00" />
            </div>
          </div>
        </section>

        <section className="surface overflow-hidden p-0">
          <h2 className="bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">الفواتير والدّين</h2>
          <div className="grid gap-3 p-4">
            <div>
              <Label htmlFor="s-tax">نسبة الضريبة الافتراضية (%)</Label>
              <Input id="s-tax" type="number" min={0} max={100} step="0.01" disabled={!isOwner} value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="s-footer">نص أسفل الفاتورة</Label>
              <textarea
                id="s-footer"
                disabled={!isOwner}
                value={receiptFooter}
                onChange={(e) => setReceiptFooter(e.target.value)}
                rows={3}
                maxLength={300}
                placeholder="شكرًا لزيارتكم — المرتجعات خلال 7 أيام..."
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={!isOwner}
                onClick={() => setReceiptShowQr((v) => !v)}
                className={`h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${receiptShowQr ? "bg-[var(--primary)]" : "bg-[var(--muted)]"}`}
                aria-label="إظهار رمز QR في الفاتورة"
              >
                <span className={`block size-5 rounded-full bg-white shadow transition-transform ${receiptShowQr ? "translate-x-0.5" : "translate-x-5"}`} />
              </button>
              <Label>إظهار رمز QR في الفاتورة المطبوعة</Label>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
              <div>
                <Label htmlFor="s-credit-limit">سقف دّين الزبون (دج)</Label>
                <Input id="s-credit-limit" type="number" min={0} disabled={!isOwner} value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="s-credit-days">مهلة الدّين (أيام)</Label>
                <Input id="s-credit-days" type="number" min={0} disabled={!isOwner} value={creditOverdueDays} onChange={(e) => setCreditOverdueDays(e.target.value)} />
              </div>
            </div>
          </div>
        </section>
      </div>

      {isOwner && (
        <Button size="lg" disabled={saving} onClick={() => void save()}>
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
          حفظ الإعدادات
        </Button>
      )}
    </div>
  );
}
