import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { findBarcodeConflict, mapProductError, validateBarcode } from "@/lib/productBarcodes";
import type { ProductBarcodeRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/products/ConfirmDialog";

const NOTE_MAX = 120;

/**
 * Extra barcodes (product_barcodes) of one product: add, edit in place
 * (barcode + note) and remove with a confirm. Every write is validated
 * against SUMA Web's barcode format and pre-checked across all three
 * barcode tables for a readable message; the database's cross-table
 * trigger stays the real guarantee. RLS: admin or can_manage_products.
 * Online-only — the parent passes `disabledReason` when offline.
 */
export function ExtraBarcodesSection({
  storeId,
  productId,
  rows,
  onRowsChange,
  canManage,
  disabledReason,
}: {
  storeId: string;
  productId: string | null;
  rows: ProductBarcodeRow[];
  onRowsChange: (rows: ProductBarcodeRow[]) => void;
  canManage: boolean;
  /** Set when writes aren't possible right now (offline) — shown instead. */
  disabledReason: string | null;
}) {
  const [newCode, setNewCode] = useState("");
  const [newNote, setNewNote] = useState("");
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCode, setEditCode] = useState("");
  const [editNote, setEditNote] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [removeTarget, setRemoveTarget] = useState<ProductBarcodeRow | null>(null);
  const [removing, setRemoving] = useState(false);

  const writable = canManage && !disabledReason && Boolean(productId);

  async function add() {
    if (!productId) return;
    const check = validateBarcode(newCode);
    if (!check.ok) return toast.error(check.error);
    if (!check.value) return toast.error("أدخل الباركود الإضافي.");
    setAdding(true);
    const conflict = await findBarcodeConflict(storeId, check.value, {}, productId);
    if (conflict) {
      setAdding(false);
      return toast.error(conflict);
    }
    const { data, error } = await supabase
      .from("product_barcodes")
      .insert({ product_id: productId, store_id: storeId, barcode: check.value, note: newNote.trim() || null })
      .select()
      .single();
    setAdding(false);
    if (error) return toast.error(mapProductError(error));
    onRowsChange([...rows, data as ProductBarcodeRow]);
    setNewCode("");
    setNewNote("");
    toast.success("تزاد الباركود الإضافي.");
  }

  function startEdit(row: ProductBarcodeRow) {
    setEditingId(row.id);
    setEditCode(row.barcode);
    setEditNote(row.note ?? "");
  }

  async function saveEdit(row: ProductBarcodeRow) {
    const check = validateBarcode(editCode);
    if (!check.ok) return toast.error(check.error);
    if (!check.value) return toast.error("الباركود ما يقدرش يكون فارغ — احذفه بدل ما تفرّغه.");
    const note = editNote.trim() || null;
    if (check.value === row.barcode && note === (row.note ?? null)) {
      setEditingId(null);
      return;
    }
    setSavingEdit(true);
    if (check.value !== row.barcode) {
      const conflict = await findBarcodeConflict(storeId, check.value, { extraBarcodeId: row.id }, productId);
      if (conflict) {
        setSavingEdit(false);
        return toast.error(conflict);
      }
    }
    const { data, error } = await supabase
      .from("product_barcodes")
      .update({ barcode: check.value, note })
      .eq("id", row.id)
      .eq("store_id", storeId)
      .select()
      .single();
    setSavingEdit(false);
    if (error) return toast.error(mapProductError(error));
    onRowsChange(rows.map((r) => (r.id === row.id ? (data as ProductBarcodeRow) : r)));
    setEditingId(null);
    toast.success("تم تحديث الباركود.");
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    const { error } = await supabase.from("product_barcodes").delete().eq("id", removeTarget.id).eq("store_id", storeId);
    setRemoving(false);
    if (error) return toast.error(mapProductError(error));
    onRowsChange(rows.filter((r) => r.id !== removeTarget.id));
    setRemoveTarget(null);
    toast.success("تم حذف الباركود الإضافي.");
  }

  return (
    <section className="surface overflow-hidden p-0">
      <h2 className="bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">باركودات إضافية</h2>
      <div className="p-4">
        {!productId ? (
          <p className="text-xs text-muted-foreground">احفظ المنتج أولًا لتقدر تضيف باركودات إضافية له.</p>
        ) : (
          <>
            {writable && (
              <div className="grid gap-2">
                <div className="flex gap-2">
                  <Input
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void add();
                      }
                    }}
                    placeholder="باركود إضافي..."
                    dir="ltr"
                    maxLength={64}
                  />
                  <Button type="button" variant="outline" disabled={adding} onClick={() => void add()} aria-label="إضافة باركود">
                    {adding ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
                  </Button>
                </div>
                <Input value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="ملاحظة (اختياري): علبة 6، حجم عائلي..." maxLength={NOTE_MAX} />
              </div>
            )}
            {disabledReason && canManage && <p className="text-xs text-muted-foreground">{disabledReason}</p>}
            {!canManage && <p className="text-xs text-muted-foreground">تعديل الباركودات يحتاج صلاحية إدارة المنتجات.</p>}

            {rows.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">ما كانش باركودات إضافية لهذا المنتج.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {rows.map((b) =>
                  editingId === b.id ? (
                    <li key={b.id} className="grid gap-1.5 py-2">
                      <Input value={editCode} onChange={(e) => setEditCode(e.target.value)} dir="ltr" maxLength={64} autoFocus />
                      <div className="flex gap-2">
                        <Input value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="ملاحظة" maxLength={NOTE_MAX} />
                        <Button type="button" size="icon" disabled={savingEdit} onClick={() => void saveEdit(b)} aria-label="حفظ">
                          {savingEdit ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
                        </Button>
                        <Button type="button" size="icon" variant="outline" onClick={() => setEditingId(null)} aria-label="إلغاء">
                          <X className="size-4" aria-hidden />
                        </Button>
                      </div>
                    </li>
                  ) : (
                    <li key={b.id} className="flex items-center gap-2 py-1.5 text-sm">
                      <span className="num" dir="ltr">
                        {b.barcode}
                      </span>
                      {b.note && <span className="truncate text-xs text-muted-foreground">— {b.note}</span>}
                      {writable && (
                        <span className="ms-auto flex shrink-0 items-center gap-2">
                          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => startEdit(b)} aria-label="تعديل">
                            <Pencil className="size-3.5" aria-hidden />
                          </button>
                          <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => setRemoveTarget(b)} aria-label="حذف">
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        </span>
                      )}
                    </li>
                  ),
                )}
              </ul>
            )}
          </>
        )}
      </div>

      {removeTarget && (
        <ConfirmDialog
          zIndexClass="z-[60]"
          title="تحذف هذا الباركود الإضافي؟"
          description={
            <span>
              الباركود <span className="num font-semibold" dir="ltr">{removeTarget.barcode}</span> ما عادش يتعرّف على هذا المنتج عند المسح.
            </span>
          }
          confirmLabel="حذف"
          pending={removing}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => void confirmRemove()}
        />
      )}
    </section>
  );
}
