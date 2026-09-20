import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, Plus, Trash2, Truck, XCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { createPurchaseOrder, receivePurchaseOrder, cancelPurchaseOrder } from "@/lib/rpc";
import { useStore } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";
import { formatDA, formatDateTime } from "@/lib/format";
import type { ProductRow, PurchaseOrderItemRow, PurchaseOrderRow, PurchaseOrderStatus, SupplierRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  draft: "مسودة",
  partially_received: "مستلم جزئيًا",
  received: "مستلم بالكامل",
  cancelled: "ملغى",
};

const STATUS_CLASS: Record<PurchaseOrderStatus, string> = {
  draft: "bg-[var(--muted)] text-muted-foreground",
  partially_received: "bg-[var(--warning)] text-[var(--warning-foreground)]",
  received: "bg-[var(--primary)]/10 text-[var(--primary)]",
  cancelled: "bg-[var(--destructive)]/10 text-destructive",
};

/**
 * أوامر الشراء واستلام البضاعة — a UI on top of tables that were already
 * fully built and live for SUMA Web (suppliers/purchase_orders/
 * purchase_order_items, receive_purchase_order already GRANT EXECUTE'd
 * to `authenticated` and already writing stock_movements as of this same
 * session's ledger migration). SUMA PC never had a screen for this at
 * all — "المشتريات" routed to ComingSoonPage — so this is new UI over an
 * existing, unmodified data model, not a new feature invented here.
 *
 * This is the answer to "إضافة المخزون لا تجعلها مجرد +10": receiving a
 * PO here carries supplier + reference (the PO itself) + line cost + who
 * received it + when, and it's how a genuinely NEW product's initial
 * stock should be added — create the product first (شاشة المنتجات),
 * then receive it here against a real purchase order, rather than typing
 * a number into the quick +/- on the المخزون screen.
 */
export function PurchasesPage({ openSuppliers }: { openSuppliers?: boolean }) {
  const { active, perms } = useStore();
  const { isOnline } = useSync();
  const storeId = active!.id;

  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [orders, setOrders] = useState<PurchaseOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [itemsByOrder, setItemsByOrder] = useState<Record<string, PurchaseOrderItemRow[]>>({});
  const [receiveQty, setReceiveQty] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [supplierDialogOpen, setSupplierDialogOpen] = useState(Boolean(openSuppliers));

  useEffect(() => {
    if (openSuppliers) setSupplierDialogOpen(true);
  }, [openSuppliers]);

  async function loadSuppliers() {
    const { data, error } = await supabase.from("suppliers").select("*").eq("store_id", storeId).order("name");
    if (error) return toast.error(error.message);
    setSuppliers(data ?? []);
  }

  async function loadOrders() {
    setLoading(true);
    const { data, error } = await supabase
      .from("purchase_orders")
      .select("*")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(100);
    setLoading(false);
    if (error) return toast.error(error.message);
    setOrders(data ?? []);
  }

  useEffect(() => {
    void loadSuppliers();
    void loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function toggleExpand(po: PurchaseOrderRow) {
    if (expandedId === po.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(po.id);
    if (!itemsByOrder[po.id]) {
      const { data, error } = await supabase.from("purchase_order_items").select("*").eq("purchase_order_id", po.id);
      if (error) return toast.error(error.message);
      setItemsByOrder((prev) => ({ ...prev, [po.id]: data ?? [] }));
    }
  }

  async function receiveAll(po: PurchaseOrderRow) {
    setBusyId(po.id);
    const { error } = await receivePurchaseOrder({ _po_id: po.id, _store_id: storeId });
    setBusyId(null);
    if (error) return toast.error(error.message);
    toast.success("تم استلام البضاعة وتحديث المخزون.");
    setItemsByOrder((prev) => {
      const next = { ...prev };
      delete next[po.id];
      return next;
    });
    void loadOrders();
  }

  /** Partial receiving — one line at a time, via receive_purchase_order's
   * own _items param (already supported server-side, just never exposed
   * in this UI). Stock updates and stock_movements logging happen exactly
   * the same way "استلام الكل" already does, just scoped to one line. */
  async function receiveOne(po: PurchaseOrderRow, item: PurchaseOrderItemRow) {
    const remaining = Number(item.quantity) - Number(item.received_quantity);
    const qty = Number(receiveQty[item.id] ?? remaining);
    if (!Number.isFinite(qty) || qty <= 0) return toast.error("كمية استلام غير صالحة.");
    if (qty > remaining) return toast.error("الكمية المطلوب استلامها أكبر من المتبقي.");
    setBusyId(po.id);
    const { error } = await receivePurchaseOrder({
      _po_id: po.id,
      _store_id: storeId,
      _items: [{ purchase_order_item_id: item.id, quantity: qty }],
    });
    setBusyId(null);
    if (error) return toast.error(error.message);
    toast.success(`تم استلام ${qty} من ${item.product_name}.`);
    const { data } = await supabase.from("purchase_order_items").select("*").eq("purchase_order_id", po.id);
    setItemsByOrder((prev) => ({ ...prev, [po.id]: data ?? [] }));
    setReceiveQty((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    void loadOrders();
  }

  async function cancel(po: PurchaseOrderRow) {
    setBusyId(po.id);
    const { error } = await cancelPurchaseOrder({ _po_id: po.id, _store_id: storeId });
    setBusyId(null);
    if (error) return toast.error(error.message);
    toast.success("تم إلغاء أمر الشراء.");
    void loadOrders();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">المشتريات</h1>
          <p className="text-xs text-muted-foreground num">{orders.length} أمر شراء</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setSupplierDialogOpen(true)}>
            <Truck className="size-4" aria-hidden />
            الموردون
          </Button>
          {perms.isAdmin && (
            <Button disabled={!isOnline} title={!isOnline ? "يحتاج اتصالاً بالإنترنت" : undefined} onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden />
              أمر شراء جديد
            </Button>
          )}
        </div>
      </div>

      {!isOnline && (
        <div className="surface border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-xs">
          المشتريات تحتاج اتصالاً بالإنترنت — أنشئ أوامر الشراء واستلم البضاعة بعد عودة الاتصال.
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">جاري التحميل...</p>
      ) : orders.length === 0 ? (
        <div className="surface py-8 text-center text-sm text-muted-foreground">ما كانش أوامر شراء بعد.</div>
      ) : (
        <div className="surface overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
                <th className="px-3 py-2 text-start font-bold">التاريخ</th>
                <th className="px-3 py-2 text-start font-bold">المورد</th>
                <th className="px-3 py-2 text-start font-bold">الحالة</th>
                <th className="w-32 px-3 py-2 text-end font-bold">القيمة</th>
                <th className="w-52 px-3 py-2 text-center font-bold">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((po, i) => {
                const isOpen = expandedId === po.id;
                const items = itemsByOrder[po.id] ?? [];
                return (
                  <>
                    <tr key={po.id} className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"}`}>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{formatDateTime(po.created_at)}</td>
                      <td className="px-3 py-2">{suppliers.find((s) => s.id === po.supplier_id)?.name ?? "بدون مورد"}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${STATUS_CLASS[po.status]}`}>{STATUS_LABEL[po.status]}</span>
                      </td>
                      <td className="px-3 py-2 text-end font-bold num">{formatDA(po.total_cost)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-center gap-1.5">
                          <Button variant="outline" size="icon" className="size-7" onClick={() => void toggleExpand(po)} aria-label="تفاصيل">
                            {isOpen ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
                          </Button>
                          {perms.isAdmin && (po.status === "draft" || po.status === "partially_received") && (
                            <Button size="sm" disabled={busyId === po.id || !isOnline} onClick={() => void receiveAll(po)}>
                              {busyId === po.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="size-3.5" aria-hidden />}
                              استلام الكل
                            </Button>
                          )}
                          {perms.isAdmin && po.status === "draft" && (
                            <Button variant="outline" size="icon" className="size-7" disabled={busyId === po.id} onClick={() => void cancel(po)} aria-label="إلغاء">
                              <XCircle className="size-3.5 text-destructive" aria-hidden />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`${po.id}-items`} className="border-b border-border bg-[var(--muted)]/50">
                        <td colSpan={5} className="px-3 py-2">
                          {items.length === 0 ? (
                            <p className="text-xs text-muted-foreground">جاري التحميل...</p>
                          ) : (
                            <ul className="grid gap-1.5 text-xs">
                              {items.map((it) => {
                                const remaining = Number(it.quantity) - Number(it.received_quantity);
                                return (
                                  <li key={it.id} className="flex items-center justify-between gap-2">
                                    <span>{it.product_name}</span>
                                    <div className="flex items-center gap-2">
                                      <span className="text-muted-foreground num">
                                        {it.received_quantity} / {it.quantity} × {formatDA(it.unit_cost)}
                                      </span>
                                      {perms.isAdmin && remaining > 0 && po.status !== "cancelled" && (
                                        <>
                                          <Input
                                            type="number"
                                            min="1"
                                            max={remaining}
                                            value={receiveQty[it.id] ?? String(remaining)}
                                            onChange={(e) => setReceiveQty((prev) => ({ ...prev, [it.id]: e.target.value }))}
                                            className="h-7 w-16 text-center text-xs"
                                          />
                                          <Button
                                            size="sm"
                                            className="h-7 px-2 text-[11px]"
                                            disabled={busyId === po.id || !isOnline}
                                            onClick={() => void receiveOne(po, it)}
                                          >
                                            استلم
                                          </Button>
                                        </>
                                      )}
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <CreatePurchaseOrderDialog
          storeId={storeId}
          suppliers={suppliers}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void loadOrders();
          }}
        />
      )}

      {supplierDialogOpen && (
        <SuppliersDialog storeId={storeId} suppliers={suppliers} canWrite={perms.isAdmin} onClose={() => setSupplierDialogOpen(false)} onChanged={loadSuppliers} />
      )}
    </div>
  );
}

type DraftLine = { productId: string; productName: string; quantity: string; unitCost: string };

function CreatePurchaseOrderDialog({
  storeId,
  suppliers,
  onClose,
  onCreated,
}: {
  storeId: string;
  suppliers: SupplierRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ productId: "", productName: "", quantity: "1", unitCost: "0" }]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("store_id", storeId)
        .order("name")
        .limit(1000);
      if (error) return toast.error(error.message);
      setProducts(data ?? []);
    })();
  }, [storeId]);

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function pickProduct(i: number, productId: string) {
    const p = products.find((x) => x.id === productId);
    updateLine(i, { productId, productName: p?.name ?? "", unitCost: p?.purchase_price != null ? String(p.purchase_price) : "0" });
  }

  const total = lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unitCost) || 0), 0);

  async function save() {
    const validLines = lines.filter((l) => l.productId && Number(l.quantity) > 0);
    if (validLines.length === 0) return toast.error("أضف صنفًا واحدًا على الأقل باختيار منتج وكمية صحيحة.");
    setSaving(true);
    const { error } = await createPurchaseOrder({
      _store_id: storeId,
      _items: validLines.map((l) => ({ product_id: l.productId, product_name: l.productName, quantity: Number(l.quantity), unit_cost: Number(l.unitCost) || 0 })),
      _supplier_id: supplierId || undefined,
      _notes: notes.trim() || undefined,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("تم إنشاء أمر الشراء.");
    onCreated();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="surface flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-border p-4">
          <h2 className="font-bold">أمر شراء جديد</h2>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <div>
            <Label htmlFor="supplier">المورد</Label>
            <select id="supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">بدون مورد</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label>الأصناف</Label>
            {lines.map((l, i) => (
              <div key={i} className="flex items-end gap-1.5">
                <div className="flex-1">
                  <select
                    value={l.productId}
                    onChange={(e) => pickProduct(i, e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  >
                    <option value="">اختر منتجًا...</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Input
                  type="number"
                  min="1"
                  value={l.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  className="w-20"
                  placeholder="كمية"
                />
                <Input
                  type="number"
                  min="0"
                  value={l.unitCost}
                  onChange={(e) => updateLine(i, { unitCost: e.target.value })}
                  className="w-24"
                  placeholder="سعر الوحدة"
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="size-9 shrink-0"
                  onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                  disabled={lines.length === 1}
                  aria-label="حذف الصنف"
                >
                  <Trash2 className="size-3.5 text-destructive" aria-hidden />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, { productId: "", productName: "", quantity: "1", unitCost: "0" }])}>
              <Plus className="size-3.5" aria-hidden />
              إضافة صنف
            </Button>
          </div>

          <div>
            <Label htmlFor="po-notes">ملاحظات (اختياري)</Label>
            <Input id="po-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
          </div>

          <p className="text-sm font-bold">
            الإجمالي: <span className="num">{formatDA(total)}</span>
          </p>
        </div>
        <div className="flex gap-2 border-t border-border p-4">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            إلغاء
          </Button>
          <Button className="flex-1" disabled={saving} onClick={() => void save()}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            إنشاء أمر الشراء
          </Button>
        </div>
      </div>
    </div>
  );
}

function SuppliersDialog({
  storeId,
  suppliers,
  canWrite,
  onClose,
  onChanged,
}: {
  storeId: string;
  suppliers: SupplierRow[];
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [creating, setCreating] = useState(false);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const { error } = await supabase.from("suppliers").insert({ store_id: storeId, name: trimmed, phone: phone.trim() || null });
    setCreating(false);
    if (error) return toast.error(error.message);
    setName("");
    setPhone("");
    toast.success("تمت إضافة المورد.");
    onChanged();
  }

  async function toggle(s: SupplierRow) {
    const { error } = await supabase.from("suppliers").update({ is_active: !s.is_active }).eq("id", s.id).eq("store_id", storeId);
    if (error) return toast.error(error.message);
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="surface w-full max-w-md p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 font-bold">الموردون</h2>
        {canWrite ? (
          <div className="mb-4 flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم المورد" className="flex-1" maxLength={80} />
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="الهاتف" className="w-32" dir="ltr" />
            <Button disabled={!name.trim() || creating} onClick={() => void create()}>
              زيد
            </Button>
          </div>
        ) : (
          <p className="mb-4 text-xs text-muted-foreground">إضافة أو تعديل الموردين محجوز لصاحب المحل أو المدير.</p>
        )}
        <ul className="max-h-72 space-y-2 overflow-y-auto">
          {suppliers.length === 0 && <li className="py-4 text-center text-sm text-muted-foreground">ما كانش موردون بعد.</li>}
          {suppliers.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-xl border border-border p-2">
              <div className="flex-1">
                <p className="text-sm font-medium">{s.name}</p>
                {s.phone && (
                  <p className="text-xs text-muted-foreground num" dir="ltr">
                    {s.phone}
                  </p>
                )}
              </div>
              {canWrite ? (
                <button
                  type="button"
                  onClick={() => void toggle(s)}
                  className={`h-6 w-11 shrink-0 rounded-full transition-colors ${s.is_active ? "bg-[var(--primary)]" : "bg-[var(--muted)]"}`}
                  aria-label="تفعيل المورد"
                >
                  <span className={`block size-5 rounded-full bg-white shadow transition-transform ${s.is_active ? "translate-x-0.5" : "translate-x-5"}`} />
                </button>
              ) : (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.is_active ? "bg-[var(--primary)]/10 text-[var(--primary)]" : "bg-[var(--muted)] text-muted-foreground"}`}>
                  {s.is_active ? "مفعّل" : "معطّل"}
                </span>
              )}
            </li>
          ))}
        </ul>
        <Button variant="outline" className="mt-3 w-full" onClick={onClose}>
          إغلاق
        </Button>
      </div>
    </div>
  );
}
