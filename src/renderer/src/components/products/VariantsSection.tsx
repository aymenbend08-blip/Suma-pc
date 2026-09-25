import { useRef, useState } from "react";
import { toast } from "sonner";
import { Ban, CheckCircle2, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { findBarcodeConflict, mapProductError, validateBarcode } from "@/lib/productBarcodes";
import { uploadProductImage } from "@/lib/productImages";
import type { ProductVariantRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/products/ConfirmDialog";

const VARIANT_NAME_MAX = 120;
const ATTR_KEY_MAX = 40;
const ATTR_VALUE_MAX = 120;
const ATTR_MAX_ROWS = 20;

type AttrRow = { key: string; value: string; original?: unknown };

function attrText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function attributesToRows(attributes: Record<string, unknown> | null | undefined): AttrRow[] {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) return [];
  return Object.entries(attributes).map(([key, value]) => ({ key, value: attrText(value), original: value }));
}

/** Rows -> jsonb object. A value whose text wasn't touched keeps its
 * original JSON type (a number stays a number) instead of being silently
 * rewritten as a string. Returns an error message for an invalid set. */
function rowsToAttributes(rows: AttrRow[]): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    const value = row.value.trim();
    if (!key && !value) continue;
    if (!key) return { ok: false, error: "كل خاصية لازم يكون عندها اسم (مثلاً: اللون)." };
    if (key in out) return { ok: false, error: `الخاصية «${key}» مكررة.` };
    out[key] = row.original !== undefined && attrText(row.original) === row.value ? row.original : value;
  }
  return { ok: true, value: out };
}

function attributesSummary(attributes: Record<string, unknown> | null | undefined): string {
  return attributesToRows(attributes)
    .map((r) => `${r.key}: ${r.value}`)
    .join(" · ");
}

/**
 * Real variant management for one product (product_variants). SUMA's
 * model: a variant is a named, barcoded presentation of the product and
 * shares its price and stock — sales always apply to the base product —
 * so this never writes a variant selling_price/stock_quantity. RLS:
 * insert/update = admin or can_manage_products; delete = admin only.
 * Deleting a variant that already appears on sales is allowed (the sale
 * lines keep variant_name; the FK is ON DELETE SET NULL) but deactivating
 * is offered first since it keeps the trace intact.
 */
export function VariantsSection({
  storeId,
  productId,
  variants,
  onVariantsChange,
  canManage,
  canDelete,
  disabledReason,
}: {
  storeId: string;
  productId: string | null;
  variants: ProductVariantRow[];
  onVariantsChange: (rows: ProductVariantRow[]) => void;
  canManage: boolean;
  canDelete: boolean;
  disabledReason: string | null;
}) {
  const [dialog, setDialog] = useState<{ variant: ProductVariantRow | null } | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ variant: ProductVariantRow; salesCount: number } | null>(null);
  const [checkingDeleteId, setCheckingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const writable = canManage && !disabledReason && Boolean(productId);

  function replaceRow(row: ProductVariantRow) {
    const exists = variants.some((v) => v.id === row.id);
    const next = exists ? variants.map((v) => (v.id === row.id ? row : v)) : [...variants, row];
    onVariantsChange(next.sort((a, b) => a.variant_name.localeCompare(b.variant_name, "ar")));
  }

  async function toggleActive(v: ProductVariantRow) {
    setTogglingId(v.id);
    const { data, error } = await supabase
      .from("product_variants")
      .update({ is_active: !v.is_active })
      .eq("id", v.id)
      .eq("store_id", storeId)
      .select()
      .single();
    setTogglingId(null);
    if (error) return toast.error(mapProductError(error));
    replaceRow(data as ProductVariantRow);
    toast.success(v.is_active ? "تم تعطيل التنويعة." : "تم تفعيل التنويعة.");
  }

  async function askDelete(v: ProductVariantRow) {
    setCheckingDeleteId(v.id);
    const { count, error } = await supabase
      .from("sale_items")
      .select("id", { count: "exact", head: true })
      .eq("variant_id", v.id);
    setCheckingDeleteId(null);
    if (error) return toast.error(error.message);
    setDeleteTarget({ variant: v, salesCount: count ?? 0 });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase
      .from("product_variants")
      .delete()
      .eq("id", deleteTarget.variant.id)
      .eq("store_id", storeId);
    setDeleting(false);
    if (error) return toast.error(mapProductError(error));
    onVariantsChange(variants.filter((v) => v.id !== deleteTarget.variant.id));
    setDeleteTarget(null);
    toast.success("تم حذف التنويعة.");
  }

  async function deactivateInstead() {
    if (!deleteTarget) return;
    const v = deleteTarget.variant;
    setDeleteTarget(null);
    if (v.is_active) await toggleActive(v);
  }

  return (
    <section className="surface overflow-hidden p-0 lg:col-span-2">
      <h2 className="flex items-center bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">
        التنويعات (Variants)
        {writable && (
          <button
            type="button"
            className="ms-auto flex items-center gap-1 rounded-md bg-white/15 px-2 py-0.5 text-xs font-semibold hover:bg-white/25"
            onClick={() => setDialog({ variant: null })}
          >
            <Plus className="size-3.5" aria-hidden />
            تنويعة جديدة
          </button>
        )}
      </h2>
      <div className="p-4">
        <p className="mb-2 text-xs text-muted-foreground">
          السعر والمخزون مشتركان مع المنتج الأساسي — التنويعة اسم وباركود وخصائص فقط، وكل بيع لها يُنقص مخزون المنتج الأساسي.
        </p>
        {!productId ? (
          <p className="text-xs text-muted-foreground">احفظ المنتج أولًا لتقدر تضيف تنويعات له.</p>
        ) : (
          <>
            {disabledReason && canManage && <p className="mb-2 text-xs text-muted-foreground">{disabledReason}</p>}
            {variants.length === 0 ? (
              <p className="text-xs text-muted-foreground">ما كانش تنويعات لهذا المنتج.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[var(--muted)] text-xs text-muted-foreground">
                      <th className="px-3 py-1.5 text-start font-semibold">التنويعة</th>
                      <th className="px-3 py-1.5 text-start font-semibold">الباركود</th>
                      <th className="px-3 py-1.5 text-start font-semibold">الخصائص</th>
                      <th className="w-20 px-3 py-1.5 text-center font-semibold">الحالة</th>
                      {writable && <th className="w-28 px-3 py-1.5 text-center font-semibold">إجراءات</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {variants.map((v) => (
                      <tr key={v.id} className={`border-t border-border ${v.is_active ? "" : "opacity-60"}`}>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-2">
                            {v.image_url ? (
                              <img src={v.image_url} alt="" className="size-7 shrink-0 rounded object-cover" />
                            ) : (
                              <div className="size-7 shrink-0 rounded bg-[var(--muted)]" />
                            )}
                            <span className="font-medium">{v.variant_name}</span>
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-xs text-muted-foreground num" dir="ltr">
                          {v.barcode ?? "—"}
                        </td>
                        <td className="max-w-56 truncate px-3 py-1.5 text-xs text-muted-foreground" title={attributesSummary(v.attributes)}>
                          {attributesSummary(v.attributes) || "—"}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          {v.is_active ? (
                            <span className="rounded-full bg-[var(--primary)]/10 px-2 py-0.5 text-[11px] font-semibold text-[var(--primary)]">مفعّلة</span>
                          ) : (
                            <span className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">معطّلة</span>
                          )}
                        </td>
                        {writable && (
                          <td className="px-3 py-1.5">
                            <div className="flex items-center justify-center gap-1.5">
                              <Button size="icon" variant="outline" className="size-7" aria-label="تعديل" onClick={() => setDialog({ variant: v })}>
                                <Pencil className="size-3.5" aria-hidden />
                              </Button>
                              <Button
                                size="icon"
                                variant="outline"
                                className="size-7"
                                aria-label={v.is_active ? "تعطيل" : "تفعيل"}
                                title={v.is_active ? "تعطيل" : "تفعيل"}
                                disabled={togglingId === v.id}
                                onClick={() => void toggleActive(v)}
                              >
                                {togglingId === v.id ? (
                                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                                ) : v.is_active ? (
                                  <Ban className="size-3.5" aria-hidden />
                                ) : (
                                  <CheckCircle2 className="size-3.5" aria-hidden />
                                )}
                              </Button>
                              {canDelete && (
                                <Button
                                  size="icon"
                                  variant="outline"
                                  className="size-7"
                                  aria-label="حذف"
                                  disabled={checkingDeleteId === v.id}
                                  onClick={() => void askDelete(v)}
                                >
                                  {checkingDeleteId === v.id ? (
                                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                                  ) : (
                                    <Trash2 className="size-3.5 text-destructive" aria-hidden />
                                  )}
                                </Button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {dialog && productId && (
        <VariantDialog
          storeId={storeId}
          productId={productId}
          variant={dialog.variant}
          onClose={() => setDialog(null)}
          onSaved={(row) => {
            replaceRow(row);
            setDialog(null);
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          zIndexClass="z-[60]"
          title={`تحذف التنويعة «${deleteTarget.variant.variant_name}»؟`}
          description={
            deleteTarget.salesCount > 0 ? (
              <span>
                هذه التنويعة ظاهرة في <span className="num font-semibold">{deleteTarget.salesCount}</span> سطر بيع سابق. الحذف يبقي اسمها
                على الفواتير لكن يقطع الربط بها — الأفضل تعطيلها بدل الحذف.
              </span>
            ) : (
              "لا يمكن التراجع عن الحذف. باركودها ما عادش يتعرّف عليه عند المسح."
            )
          }
          confirmLabel="حذف نهائي"
          pending={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
          extraAction={
            deleteTarget.salesCount > 0 && deleteTarget.variant.is_active ? (
              <Button className="flex-1" onClick={() => void deactivateInstead()}>
                تعطيل بدلها
              </Button>
            ) : undefined
          }
        />
      )}
    </section>
  );
}

function VariantDialog({
  storeId,
  productId,
  variant,
  onClose,
  onSaved,
}: {
  storeId: string;
  productId: string;
  variant: ProductVariantRow | null;
  onClose: () => void;
  onSaved: (row: ProductVariantRow) => void;
}) {
  const [name, setName] = useState(variant?.variant_name ?? "");
  const [barcode, setBarcode] = useState(variant?.barcode ?? "");
  const [attrs, setAttrs] = useState<AttrRow[]>(() => {
    const rows = attributesToRows(variant?.attributes);
    return rows.length > 0 ? rows : [{ key: "", value: "" }];
  });
  const [imageUrl, setImageUrl] = useState<string | null>(variant?.image_url ?? null);
  const [isActive, setIsActive] = useState(variant?.is_active ?? true);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function handleImage(file: File) {
    setUploading(true);
    const res = await uploadProductImage(storeId, file);
    setUploading(false);
    if (!res.ok) return toast.error(res.error);
    setImageUrl(res.url);
  }

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) return toast.error("لازم اسم للتنويعة.");
    if (trimmedName.length > VARIANT_NAME_MAX) return toast.error(`اسم التنويعة أطول من ${VARIANT_NAME_MAX} حرف.`);
    const code = validateBarcode(barcode);
    if (!code.ok) return toast.error(code.error);
    const attributes = rowsToAttributes(attrs);
    if (!attributes.ok) return toast.error(attributes.error);

    setSaving(true);
    const barcodeValue = code.value || null;
    if (barcodeValue && barcodeValue !== (variant?.barcode ?? null)) {
      const conflict = await findBarcodeConflict(storeId, barcodeValue, { variantId: variant?.id ?? null }, productId);
      if (conflict) {
        setSaving(false);
        return toast.error(conflict);
      }
    }
    // Price and stock are never written — they stay the base product's.
    const payload = {
      variant_name: trimmedName,
      barcode: barcodeValue,
      attributes: attributes.value,
      image_url: imageUrl,
      is_active: isActive,
    };
    const { data, error } = variant
      ? await supabase.from("product_variants").update(payload).eq("id", variant.id).eq("store_id", storeId).select().single()
      : await supabase
          .from("product_variants")
          .insert({ ...payload, product_id: productId, store_id: storeId })
          .select()
          .single();
    setSaving(false);
    if (error) return toast.error(mapProductError(error));
    toast.success(variant ? "تم تحديث التنويعة." : "تزادت التنويعة.");
    onSaved(data as ProductVariantRow);
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="surface flex max-h-[85vh] w-full max-w-md flex-col p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="font-bold">{variant ? "تعديل تنويعة" : "تنويعة جديدة"}</h2>
          <Button variant="ghost" size="icon" className="ms-auto" onClick={onClose} aria-label="إغلاق">
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        <div className="grid gap-3 overflow-y-auto">
          <div className="flex items-center gap-3">
            <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed border-border bg-muted">
              {imageUrl ? <img src={imageUrl} alt="" className="size-full object-cover" /> : <span className="text-[9px] text-muted-foreground">بلا صورة</span>}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImage(file);
                e.target.value = "";
              }}
            />
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? "جاري الرفع..." : imageUrl ? "بدّل الصورة" : "ارفع صورة"}
              </Button>
              {imageUrl && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setImageUrl(null)}>
                  إزالة
                </Button>
              )}
            </div>
          </div>
          <div>
            <Label htmlFor="v-name">اسم التنويعة *</Label>
            <Input id="v-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={VARIANT_NAME_MAX} placeholder="أحمر / XL، 500 مل..." autoFocus />
          </div>
          <div>
            <Label htmlFor="v-barcode">Barcode</Label>
            <Input id="v-barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} dir="ltr" maxLength={64} />
          </div>
          <div>
            <Label>الخصائص</Label>
            <div className="grid gap-1.5">
              {attrs.map((row, i) => (
                <div key={i} className="flex gap-1.5">
                  <Input
                    value={row.key}
                    onChange={(e) => setAttrs((prev) => prev.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                    placeholder="الخاصية (اللون)"
                    maxLength={ATTR_KEY_MAX}
                    className="flex-1"
                  />
                  <Input
                    value={row.value}
                    onChange={(e) => setAttrs((prev) => prev.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                    placeholder="القيمة (أحمر)"
                    maxLength={ATTR_VALUE_MAX}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="حذف الخاصية"
                    onClick={() => setAttrs((prev) => (prev.length === 1 ? [{ key: "", value: "" }] : prev.filter((_, j) => j !== i)))}
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                </div>
              ))}
              {attrs.length < ATTR_MAX_ROWS && (
                <Button type="button" variant="ghost" size="sm" className="justify-start" onClick={() => setAttrs((prev) => [...prev, { key: "", value: "" }])}>
                  <Plus className="size-3.5" aria-hidden />
                  خاصية أخرى
                </Button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsActive((x) => !x)}
              className={`h-6 w-11 rounded-full transition-colors ${isActive ? "bg-[var(--primary)]" : "bg-[var(--muted)]"}`}
              aria-label="التنويعة مفعّلة"
            >
              <span className={`block size-5 rounded-full bg-white shadow transition-transform ${isActive ? "translate-x-0.5" : "translate-x-5"}`} />
            </button>
            <Label>التنويعة مفعّلة (تُعرف عند المسح)</Label>
          </div>
          <p className="text-xs text-muted-foreground">السعر والمخزون مشتركان مع المنتج الأساسي.</p>
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            إلغاء
          </Button>
          <Button className="flex-1" disabled={saving || uploading} onClick={() => void save()}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            حفظ التنويعة
          </Button>
        </div>
      </div>
    </div>
  );
}
