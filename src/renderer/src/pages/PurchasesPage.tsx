import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, Pencil, Plus, Save, Search, Trash2, Truck, X, XCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { createPurchaseOrder, receivePurchaseOrder, cancelPurchaseOrder } from "@/lib/rpc";
import { useStore } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";
import { formatDA, formatDateTime } from "@/lib/format";
import { uuid } from "@/lib/uuid";
import { localDb } from "@/lib/localdb";
import { BARCODE_FORMAT, BARCODE_LOOKUP_MIN } from "@/lib/barcodeRules";
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

  const [searchQuery, setSearchQuery] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<PurchaseOrderStatus | "">("");

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLines, setEditLines] = useState<Array<PurchaseOrderItemRow & { _new?: boolean }>>([]);
  const [savingEdit, setSavingEdit] = useState(false);

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

  async function loadProducts() {
    const { data, error } = await supabase.from("products").select("*").eq("store_id", storeId).order("name").limit(1000);
    if (error) return toast.error(error.message);
    setProducts(data ?? []);
  }

  useEffect(() => {
    void loadSuppliers();
    void loadOrders();
    void loadProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  const filteredOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return orders.filter((po) => {
      if (statusFilter && po.status !== statusFilter) return false;
      if (supplierFilter && po.supplier_id !== supplierFilter) return false;
      if (!q) return true;
      const supplierName = suppliers.find((s) => s.id === po.supplier_id)?.name ?? "";
      return supplierName.toLowerCase().includes(q) || (po.notes ?? "").toLowerCase().includes(q);
    });
  }, [orders, suppliers, searchQuery, supplierFilter, statusFilter]);

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

  /**
   * Editing a still-draft order (fix a wrong quantity/cost instead of
   * cancelling and re-typing the whole thing from scratch). No new RPC —
   * poi_admin_write/po_admin_write already grant admins direct writes on
   * purchase_orders/purchase_order_items (same RLS receive/cancel rely
   * on), so this writes those tables directly, guarded by
   * .eq("status", "draft") on every write as a race check against a
   * concurrent receive/cancel.
   */
  async function startEdit(po: PurchaseOrderRow) {
    setExpandedId(po.id);
    let items = itemsByOrder[po.id];
    if (!items) {
      const { data, error } = await supabase.from("purchase_order_items").select("*").eq("purchase_order_id", po.id);
      if (error) return toast.error(error.message);
      items = data ?? [];
      setItemsByOrder((prev) => ({ ...prev, [po.id]: items! }));
    }
    setEditLines(items.map((it) => ({ ...it })));
    setEditingId(po.id);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditLines([]);
  }

  function updateEditLine(id: string, patch: Partial<PurchaseOrderItemRow>) {
    setEditLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function removeEditLine(id: string) {
    setEditLines((prev) => prev.filter((l) => l.id !== id));
  }

  function addEditLine(po: PurchaseOrderRow, p: ProductRow) {
    setEditLines((prev) => [
      ...prev,
      {
        id: `new-${uuid()}`,
        purchase_order_id: po.id,
        product_id: p.id,
        product_name: p.name,
        quantity: 1,
        unit_cost: Number(p.purchase_price ?? 0),
        line_total: Number(p.purchase_price ?? 0),
        received_quantity: 0,
        _new: true,
      },
    ]);
  }

  async function saveEdit(po: PurchaseOrderRow) {
    const original = itemsByOrder[po.id] ?? [];
    const validLines = editLines.filter((l) => Number(l.quantity) > 0);
    if (validLines.length === 0) return toast.error("أبق صنفًا واحدًا على الأقل بكمية صحيحة.");
    setSavingEdit(true);

    const removedIds = original.filter((o) => !editLines.some((l) => l.id === o.id)).map((o) => o.id);
    if (removedIds.length > 0) {
      const { error } = await supabase
        .from("purchase_order_items")
        .delete()
        .in("id", removedIds)
        .eq("purchase_order_id", po.id);
      if (error) {
        setSavingEdit(false);
        return toast.error(error.message);
      }
    }

    for (const line of validLines) {
      const lineTotal = Number(line.quantity) * Number(line.unit_cost);
      if (line._new) {
        const { error } = await supabase.from("purchase_order_items").insert({
          purchase_order_id: po.id,
          product_id: line.product_id,
          product_name: line.product_name,
          quantity: Number(line.quantity),
          unit_cost: Number(line.unit_cost),
          line_total: lineTotal,
        });
        if (error) {
          setSavingEdit(false);
          return toast.error(error.message);
        }
      } else {
        const { error } = await supabase
          .from("purchase_order_items")
          .update({ quantity: Number(line.quantity), unit_cost: Number(line.unit_cost), line_total: lineTotal })
          .eq("id", line.id)
          .eq("purchase_order_id", po.id);
        if (error) {
          setSavingEdit(false);
          return toast.error(error.message);
        }
      }
    }

    const newTotal = validLines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.unit_cost), 0);
    const { data: updatedPo, error: totalError } = await supabase
      .from("purchase_orders")
      .update({ total_cost: newTotal })
      .eq("id", po.id)
      .eq("status", "draft")
      .select("id");
    setSavingEdit(false);
    if (totalError) return toast.error(totalError.message);
    if (!updatedPo || updatedPo.length === 0) {
      return toast.error("تعذّر الحفظ — يبدو أن الأمر تم استلامه أو إلغاؤه من جهاز آخر. حدّث الصفحة.");
    }

    toast.success("تم حفظ تعديلات أمر الشراء.");
    setEditingId(null);
    const { data } = await supabase.from("purchase_order_items").select("*").eq("purchase_order_id", po.id);
    setItemsByOrder((prev) => ({ ...prev, [po.id]: data ?? [] }));
    void loadOrders();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">المشتريات</h1>
          <p className="text-xs text-muted-foreground num">
            {filteredOrders.length === orders.length ? `${orders.length} أمر شراء` : `${filteredOrders.length} من ${orders.length} أمر شراء`}
          </p>
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

      {orders.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[160px]">
            <Search className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="بحث بالمورد أو الملاحظات..."
              className="pr-7"
            />
          </div>
          <select
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">كل الموردين</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as PurchaseOrderStatus | "")}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">كل الحالات</option>
            {(Object.keys(STATUS_LABEL) as PurchaseOrderStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">جاري التحميل...</p>
      ) : orders.length === 0 ? (
        <div className="surface py-8 text-center text-sm text-muted-foreground">ما كانش أوامر شراء بعد.</div>
      ) : filteredOrders.length === 0 ? (
        <div className="surface py-8 text-center text-sm text-muted-foreground">ما كاين أوامر مطابقة للبحث.</div>
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
              {filteredOrders.map((po, i) => {
                const isOpen = expandedId === po.id;
                const isEditing = editingId === po.id;
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
                          {perms.isAdmin && po.status === "draft" && (
                            <Button
                              variant="outline"
                              size="icon"
                              className="size-7"
                              disabled={busyId === po.id || !isOnline}
                              title={!isOnline ? "يحتاج اتصالاً بالإنترنت" : undefined}
                              onClick={() => void startEdit(po)}
                              aria-label="تعديل"
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </Button>
                          )}
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
                    {isOpen && isEditing && (
                      <tr key={`${po.id}-edit`} className="border-b border-border bg-[var(--muted)]/50">
                        <td colSpan={5} className="space-y-2 px-3 py-2">
                          <ul className="grid gap-1.5 text-xs">
                            {editLines.map((l) => (
                              <li key={l.id} className="flex items-center gap-2">
                                <span className="flex-1">{l.product_name}</span>
                                <Input
                                  type="number"
                                  min="1"
                                  value={l.quantity}
                                  onChange={(e) => updateEditLine(l.id, { quantity: Number(e.target.value) })}
                                  className="h-7 w-16 text-center text-xs"
                                />
                                <Input
                                  type="number"
                                  min="0"
                                  value={l.unit_cost}
                                  onChange={(e) => updateEditLine(l.id, { unit_cost: Number(e.target.value) })}
                                  className="h-7 w-20 text-center text-xs"
                                />
                                <Button
                                  variant="outline"
                                  size="icon"
                                  className="size-7 shrink-0"
                                  onClick={() => removeEditLine(l.id)}
                                  disabled={editLines.length === 1}
                                  aria-label="حذف الصنف"
                                >
                                  <Trash2 className="size-3.5 text-destructive" aria-hidden />
                                </Button>
                              </li>
                            ))}
                          </ul>
                          <div className="flex items-center gap-2">
                            <ProductSearchPicker products={products} value="" onPick={(p) => addEditLine(po, p)} placeholder="أضف صنفًا..." />
                          </div>
                          <p className="text-xs font-bold">
                            الإجمالي الجديد:{" "}
                            <span className="num">{formatDA(editLines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_cost), 0))}</span>
                          </p>
                          <div className="flex gap-2">
                            <Button size="sm" disabled={savingEdit} onClick={() => void saveEdit(po)}>
                              {savingEdit ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />}
                              حفظ التعديلات
                            </Button>
                            <Button variant="outline" size="sm" onClick={cancelEdit}>
                              <X className="size-3.5" aria-hidden />
                              إلغاء
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {isOpen && !isEditing && (
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
          products={products}
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

/**
 * Type-to-filter product picker (name or barcode) — replaces a plain
 * <select> that forced scrolling through up to 1000 options for a single
 * line, the opposite of "بحث→اختيار→حفظ بأقل خطوات".
 */
function ProductSearchPicker({
  products,
  value,
  onPick,
  placeholder = "اسم المنتج أو الباركود...",
}: {
  products: ProductRow[];
  value: string;
  onPick: (product: ProductRow) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => setQuery(value), [value]);

  // A scanned EXTRA or VARIANT barcode isn't on the product row itself —
  // resolve it through the same 3-step lookup POS uses (local mirror, so it
  // also works offline) and surface that product first.
  const [aliasProductId, setAliasProductId] = useState<string | null>(null);
  const storeId = products[0]?.store_id ?? null;
  useEffect(() => {
    const code = query.trim();
    setAliasProductId(null);
    if (!storeId || code.length < BARCODE_LOOKUP_MIN || !BARCODE_FORMAT.test(code)) return;
    let cancelled = false;
    void localDb.findProductByBarcode(storeId, code).then((hit) => {
      if (!cancelled && hit) setAliasProductId(hit.id);
    });
    return () => {
      cancelled = true;
    };
  }, [query, storeId]);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, 30);
    const direct = products.filter((p) => p.name.toLowerCase().includes(q) || (p.barcode ?? "").includes(q));
    const alias = aliasProductId ? products.find((p) => p.id === aliasProductId) : undefined;
    const merged = alias ? [alias, ...direct.filter((p) => p.id !== alias.id)] : direct;
    return merged.slice(0, 30);
  }, [products, query, aliasProductId]);

  return (
    <div ref={boxRef} className="relative flex-1">
      <div className="relative">
        <Search className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="pr-7"
        />
      </div>
      {open && matches.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-border bg-white shadow-lg">
          {matches.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-start text-xs hover:bg-[var(--muted)]"
                onClick={() => {
                  onPick(p);
                  setQuery(p.name);
                  setOpen(false);
                }}
              >
                <span>{p.name}</span>
                {p.barcode && <span className="text-muted-foreground num" dir="ltr">{p.barcode}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && matches.length === 0 && (
        <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-white p-2 text-center text-xs text-muted-foreground shadow-lg">
          ما كاين نتيجة.
        </div>
      )}
    </div>
  );
}

type DraftLine = { productId: string; productName: string; quantity: string; unitCost: string };

function CreatePurchaseOrderDialog({
  storeId,
  suppliers,
  products,
  onClose,
  onCreated,
}: {
  storeId: string;
  suppliers: SupplierRow[];
  products: ProductRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [supplierId, setSupplierId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ productId: "", productName: "", quantity: "1", unitCost: "0" }]);
  const [saving, setSaving] = useState(false);

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function pickProduct(i: number, p: ProductRow) {
    updateLine(i, { productId: p.id, productName: p.name, unitCost: p.purchase_price != null ? String(p.purchase_price) : "0" });
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
                <ProductSearchPicker products={products} value={l.productName} onPick={(p) => pickProduct(i, p)} />
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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [saving, setSaving] = useState(false);

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

  function startEditSupplier(s: SupplierRow) {
    setEditingId(s.id);
    setEditName(s.name);
    setEditPhone(s.phone ?? "");
  }

  async function saveSupplier(s: SupplierRow) {
    const trimmed = editName.trim();
    if (!trimmed) return toast.error("اسم المورد لا يمكن أن يكون فارغًا.");
    setSaving(true);
    const { error } = await supabase
      .from("suppliers")
      .update({ name: trimmed, phone: editPhone.trim() || null })
      .eq("id", s.id)
      .eq("store_id", storeId);
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("تم تعديل بيانات المورد.");
    setEditingId(null);
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
          {suppliers.map((s) =>
            editingId === s.id ? (
              <li key={s.id} className="space-y-1.5 rounded-xl border border-border p-2">
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="اسم المورد" maxLength={80} className="h-8 text-sm" />
                <Input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} placeholder="الهاتف" dir="ltr" className="h-8 text-sm" />
                <div className="flex gap-1.5">
                  <Button size="sm" className="h-7 flex-1 text-[11px]" disabled={saving} onClick={() => void saveSupplier(s)}>
                    {saving ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Save className="size-3" aria-hidden />}
                    حفظ
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 flex-1 text-[11px]" onClick={() => setEditingId(null)}>
                    إلغاء
                  </Button>
                </div>
              </li>
            ) : (
              <li key={s.id} className="flex items-center gap-2 rounded-xl border border-border p-2">
                <div className="flex-1">
                  <p className="text-sm font-medium">{s.name}</p>
                  {s.phone && (
                    <p className="text-xs text-muted-foreground num" dir="ltr">
                      {s.phone}
                    </p>
                  )}
                </div>
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => startEditSupplier(s)}
                    className="grid size-7 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:text-foreground"
                    aria-label="تعديل المورد"
                  >
                    <Pencil className="size-3.5" aria-hidden />
                  </button>
                )}
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
            ),
          )}
        </ul>
        <Button variant="outline" className="mt-3 w-full" onClick={onClose}>
          إغلاق
        </Button>
      </div>
    </div>
  );
}
