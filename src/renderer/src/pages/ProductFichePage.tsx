import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CloudOff, History, Loader2, Printer, Wand2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { adjustStock } from "@/lib/rpc";
import { formatDA, formatDateTime } from "@/lib/format";
import { generateBarcodeDataUrl } from "@/lib/barcode";
import { buildLabelHtml, parseLabelSize } from "@/lib/labels";
import { findBarcodeConflict, mapProductError, validateBarcode } from "@/lib/productBarcodes";
import { uploadProductImage } from "@/lib/productImages";
import { useStore } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";
import type {
  CategoryRow,
  ProductBarcodeRow,
  ProductRow,
  ProductVariantRow,
  StockMovementRow,
  SupplierRow,
} from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ExtraBarcodesSection } from "@/components/products/ExtraBarcodesSection";
import { VariantsSection } from "@/components/products/VariantsSection";
import { PriceHistorySection } from "@/components/products/PriceHistorySection";

const REASON_LABEL: Record<string, string> = {
  sale: "بيع",
  return: "إرجاع",
  purchase: "شراء",
  manual: "تعديل يدوي",
  stocktake: "جرد/تسوية",
};

// Unit lists: every value SUMA Web offers (وحدة, كغ, غرام, لتر, مل, علبة,
// كرطونة, متر, باكيتة) is selectable here, plus PC's own default 'قطعة'.
// A product whose unit is none of these (e.g. 'قارورة' from an import) keeps
// it — it's listed as an extra option and is never rewritten on save
// unless the user actually picks another unit.
const PIECE_UNITS = ["قطعة", "وحدة"];
const WEIGHT_UNITS = ["كغ", "غرام"];
const MEASURE_UNITS = ["لتر", "مل", "متر", "علبة", "كرطونة", "باكيتة"];
const DEFAULT_UNIT = "قطعة";
const LABEL_SIZES = ["80×50 مم", "58×40 مم", "40×30 مم"];

const PRICE_MAX = 99_999_999;
const NAME_MAX = 160;
const INTERNAL_CODE_MAX = 40;
const DESCRIPTION_MAX = 1000;
const POINTS_MAX = 10_000;

type SaleMethod = "piece" | "weight" | "measure";

function methodFromUnit(unit: string): SaleMethod {
  if (WEIGHT_UNITS.includes(unit)) return "weight";
  if (MEASURE_UNITS.includes(unit)) return "measure";
  return "piece";
}

/** Parses an optional numeric field; "" -> null, garbage -> NaN. */
function optionalNumber(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  return Number(t.replace(",", "."));
}

type SecondaryTab = "packaging" | "specifications" | "sizes" | "expiry";

/**
 * "Fiche Produit" — a full-screen product detail/creation view, replacing
 * the old small dialog. Same information the shop's reference software
 * groups on one card (basics, pricing, stock, sale method, barcodes,
 * label printing, plus secondary tabs for packaging/specs/sizes/expiry),
 * reorganized into SUMA's own surface-card + primary-teal-header language
 * — every input here is the existing Button/Input/Label components, no
 * new visual system. Opens both from "منتج جديد" and from a barcode scan
 * that matched nothing (see ProductsPage's handleBarcodeMiss), in which
 * case `initialBarcode` prefills the Barcode field.
 */
export function ProductFichePage({
  storeId,
  product,
  categories,
  initialBarcode,
  onClose,
  onSaved,
}: {
  storeId: string;
  product: ProductRow | null;
  categories: CategoryRow[];
  initialBarcode?: string;
  onClose: () => void;
  onSaved: (row: ProductRow) => void;
}) {
  const { perms } = useStore();
  const { isOnline } = useSync();
  // RLS: creating a product is store-admin only (products_admin_insert);
  // editing is admin or can_manage_products; a selling-price CHANGE on an
  // existing product is owner-only (trg_products_price_owner_only).
  const canWrite = product ? perms.canManageProducts : perms.isAdmin;
  const priceLocked = Boolean(product) && !perms.canUpdatePrice;
  const offlineReason = isOnline ? null : "غير متصل — التعديل يحتاج اتصالاً بالإنترنت.";

  const [name, setName] = useState(product?.name ?? "");
  const [internalCode, setInternalCode] = useState(product?.internal_code ?? "");
  const [barcode, setBarcode] = useState(product?.barcode ?? initialBarcode ?? "");
  const [categoryId, setCategoryId] = useState(product?.category_id ?? "");
  const [brand, setBrand] = useState(product?.brand ?? "");
  const [productType, setProductType] = useState(product?.product_type ?? "");
  const [imageUrl, setImageUrl] = useState<string | null>(product?.image_url ?? null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [generatingCode, setGeneratingCode] = useState(false);

  const [purchasePrice, setPurchasePrice] = useState(product?.purchase_price?.toString() ?? "");
  const [sellingPrice, setSellingPrice] = useState(product?.selling_price?.toString() ?? "");
  const [taxRate, setTaxRate] = useState(product?.tax_rate?.toString() ?? "");

  const [stockQuantity, setStockQuantity] = useState(product?.stock_quantity?.toString() ?? "0");
  const [lowStockThreshold, setLowStockThreshold] = useState(product?.low_stock_threshold?.toString() ?? "5");
  const [locationInStore, setLocationInStore] = useState(product?.location_in_store ?? "");

  const initialUnit = product?.unit ?? DEFAULT_UNIT;
  const [unit, setUnit] = useState(initialUnit);
  const [saleMethod, setSaleMethod] = useState<SaleMethod>(methodFromUnit(initialUnit));
  const [description, setDescription] = useState(product?.description ?? "");

  const [labelSize, setLabelSize] = useState(product?.label_size ?? LABEL_SIZES[0]);
  const [labelCount, setLabelCount] = useState("1");
  /** Which code the label prints: "main", "extra:<id>" or "variant:<id>". */
  const [labelChoice, setLabelChoice] = useState("main");
  const [printingLabel, setPrintingLabel] = useState(false);

  const [packaging, setPackaging] = useState(product?.packaging ?? "");
  const [specifications, setSpecifications] = useState(product?.specifications ?? "");
  const [sizes, setSizes] = useState(product?.sizes ?? "");
  const [expiryDate, setExpiryDate] = useState(product?.expiry_date ?? "");
  const [activeTab, setActiveTab] = useState<SecondaryTab>("packaging");

  const [extraBarcodes, setExtraBarcodes] = useState<ProductBarcodeRow[]>([]);

  const [recentMovements, setRecentMovements] = useState<StockMovementRow[]>([]);
  const [variants, setVariants] = useState<ProductVariantRow[]>([]);
  const [lastPurchase, setLastPurchase] = useState<{ supplierName: string | null; cost: number; date: string } | null>(null);

  const [pointsReward, setPointsReward] = useState(String(product?.points_reward ?? 0));
  const [isActive, setIsActive] = useState(product?.is_active ?? true);
  const [saving, setSaving] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  // Drag-to-move: the panel starts centered (its natural grid position) and
  // this offset is layered on top via a transform — dragging never fights
  // the centering, it just displaces it. Reset to (0, 0) for free since the
  // whole component remounts every time the modal opens (conditional render
  // in the parent), so a dragged position never leaks into the next open.
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragStateRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      const drag = dragStateRef.current;
      if (!drag) return;
      setDragOffset({ x: drag.origX + (e.clientX - drag.startX), y: drag.origY + (e.clientY - drag.startY) });
    }
    function onMouseUp() {
      dragStateRef.current = null;
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  function startDrag(e: React.MouseEvent) {
    dragStateRef.current = { startX: e.clientX, startY: e.clientY, origX: dragOffset.x, origY: dragOffset.y };
  }

  useEffect(() => {
    if (!product) return;
    void loadExtraBarcodes(product.id);
    void loadRecentMovements(product.id);
    void loadVariants(product.id);
    void loadLastPurchase(product.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  async function loadExtraBarcodes(productId: string) {
    const { data, error } = await supabase
      .from("product_barcodes")
      .select("*")
      .eq("product_id", productId)
      .order("created_at");
    if (error) return toast.error(error.message);
    setExtraBarcodes(data ?? []);
  }

  /** Read-only "why did this change" trail, same source StockPage's own
   * movement history dialog reads — just the 5 most recent, inline. */
  async function loadRecentMovements(productId: string) {
    const { data, error } = await supabase
      .from("stock_movements")
      .select("*")
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) return;
    setRecentMovements(data ?? []);
  }

  /** All variants of the product, active and inactive — managed in
   * VariantsSection, and offered as label barcodes below. */
  async function loadVariants(productId: string) {
    const { data, error } = await supabase
      .from("product_variants")
      .select("*")
      .eq("product_id", productId)
      .eq("store_id", storeId)
      .order("variant_name");
    if (error) return;
    setVariants(data ?? []);
  }

  /** Supplier + cost context for the most recent purchase receipt —
   * purchase_price on the product row is already the received unit cost
   * (receive_purchase_order sets it), so only the supplier name and date
   * need a lookup, traced through the purchase movement's reference_id. */
  async function loadLastPurchase(productId: string) {
    const { data: movement } = await supabase
      .from("stock_movements")
      .select("reference_id, created_at")
      .eq("product_id", productId)
      .eq("reason", "purchase")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!movement) return;
    let supplierName: string | null = null;
    if (movement.reference_id) {
      const { data: po } = await supabase.from("purchase_orders").select("supplier_id").eq("id", movement.reference_id).maybeSingle();
      if (po?.supplier_id) {
        const { data: supplier } = await supabase.from("suppliers").select("name").eq("id", po.supplier_id).maybeSingle();
        supplierName = supplier?.name ?? null;
      }
    }
    setLastPurchase({ supplierName, cost: Number(product?.purchase_price ?? 0), date: movement.created_at });
  }

  function selectSaleMethod(method: SaleMethod) {
    if (method === saleMethod) return;
    setSaleMethod(method);
    // Switching back to the product's own method restores its own unit
    // (which may be one outside the lists) instead of a list default.
    if (method === methodFromUnit(initialUnit)) setUnit(initialUnit);
    else if (method === "piece") setUnit(PIECE_UNITS[0]);
    else if (method === "weight") setUnit(WEIGHT_UNITS[0]);
    else setUnit(MEASURE_UNITS[0]);
  }

  /** The current method's unit list, plus the product's own unit when it
   * belongs to this method but isn't one of the known values. */
  function unitOptions(method: SaleMethod): string[] {
    const base = method === "piece" ? PIECE_UNITS : method === "weight" ? WEIGHT_UNITS : MEASURE_UNITS;
    const extras = [initialUnit, unit].filter((u) => u && methodFromUnit(u) === method && !base.includes(u));
    return [...base, ...Array.from(new Set(extras))];
  }

  async function generateCode() {
    setGeneratingCode(true);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = `S${Math.floor(100000 + Math.random() * 900000)}`;
      const { data: existing } = await supabase
        .from("products")
        .select("id")
        .eq("store_id", storeId)
        .eq("internal_code", code)
        .maybeSingle();
      if (!existing) {
        setInternalCode(code);
        setGeneratingCode(false);
        return;
      }
    }
    setGeneratingCode(false);
    toast.error("ما قدرناش نولّدو كود داخلي، عاود المحاولة.");
  }

  async function handleImageFile(file: File) {
    setUploadingImage(true);
    const res = await uploadProductImage(storeId, file);
    setUploadingImage(false);
    if (!res.ok) return toast.error(res.error);
    setImageUrl(res.url);
  }

  /** Client-side validation mirroring SUMA Web's product schema; returns
   * the first problem as an Arabic message, or null. */
  function validate(): string | null {
    const trimmedName = name.trim();
    if (!trimmedName) return "لازم اسم للمنتج.";
    if (trimmedName.length > NAME_MAX) return `اسم المنتج أطول من ${NAME_MAX} حرف.`;
    if (internalCode.trim().length > INTERNAL_CODE_MAX) return `الكود الداخلي أطول من ${INTERNAL_CODE_MAX} حرف.`;
    const code = validateBarcode(barcode);
    if (!code.ok) return code.error;
    if (!priceLocked) {
      const selling = optionalNumber(sellingPrice);
      if (selling === null) return "سعر البيع مطلوب.";
      if (!Number.isFinite(selling) || selling < 0 || selling > PRICE_MAX) return "سعر البيع لازم يكون رقم بين 0 و 99,999,999.";
    }
    const purchase = optionalNumber(purchasePrice);
    if (purchase !== null && (!Number.isFinite(purchase) || purchase < 0 || purchase > PRICE_MAX)) {
      return "سعر الشراء لازم يكون رقم بين 0 و 99,999,999.";
    }
    const tax = optionalNumber(taxRate);
    if (tax !== null && (!Number.isFinite(tax) || tax < 0 || tax > 100)) return "الضريبة لازم تكون بين 0 و 100.";
    const low = optionalNumber(lowStockThreshold);
    if (low !== null && (!Number.isFinite(low) || low < 0)) return "حد تنبيه المخزون لازم يكون 0 أو أكثر.";
    const stock = optionalNumber(stockQuantity);
    if (stock !== null && !Number.isFinite(stock)) return "المخزون لازم يكون رقم.";
    const points = optionalNumber(pointsReward);
    if (points !== null && (!Number.isInteger(points) || points < 0 || points > POINTS_MAX)) {
      return "نقاط الولاء لازم تكون عدد صحيح بين 0 و 10000.";
    }
    if (description.trim().length > DESCRIPTION_MAX) return `الوصف أطول من ${DESCRIPTION_MAX} حرف.`;
    return null;
  }

  async function save() {
    if (!isOnline) return toast.error("حفظ المنتج يحتاج اتصالاً بالإنترنت.");
    if (!canWrite) return toast.error(product ? "تعديل المنتجات يحتاج صلاحية إدارة المنتجات." : "إضافة منتج جديد محجوزة لصاحب المحل والمدير.");
    const problem = validate();
    if (problem) return toast.error(problem);
    const trimmedName = name.trim();

    const trimmedBarcode = barcode.trim() || null;
    setSaving(true);
    if (trimmedBarcode && trimmedBarcode !== (product?.barcode ?? null)) {
      const conflict = await findBarcodeConflict(storeId, trimmedBarcode, { productId: product?.id ?? null }, product?.id ?? null);
      if (conflict) {
        setSaving(false);
        return toast.error(conflict);
      }
    }

    // stock_quantity is deliberately excluded from the UPDATE payload — see
    // the delta step below. A brand-new product has no prior state to race
    // against, so its initial quantity is a plain INSERT field like any
    // other; an existing product's quantity is never written as an
    // absolute value, only ever as a server-computed delta via
    // adjust_stock (same rule the المخزون screen's own settle modal and
    // quick +/- follow).
    const basePayload: Partial<ProductRow> = {
      store_id: storeId,
      name: trimmedName,
      barcode: trimmedBarcode,
      internal_code: internalCode.trim() || null,
      category_id: categoryId || null,
      brand: brand.trim() || null,
      product_type: productType.trim() || null,
      image_url: imageUrl,
      purchase_price: optionalNumber(purchasePrice),
      tax_rate: optionalNumber(taxRate),
      low_stock_threshold: optionalNumber(lowStockThreshold) ?? 5,
      location_in_store: locationInStore.trim() || null,
      label_size: labelSize || null,
      packaging: packaging.trim() || null,
      specifications: specifications.trim() || null,
      sizes: sizes.trim() || null,
      expiry_date: expiryDate.trim() || null,
      description: description.trim() || null,
      points_reward: optionalNumber(pointsReward) ?? 0,
      is_active: isActive,
    };
    // Never send a price the user isn't allowed to change (the owner-only
    // trigger would reject the whole update even with the same value
    // mistyped), and never rewrite an existing product's unit that the
    // user didn't touch — e.g. a SUMA Web unit outside PC's lists.
    if (!priceLocked) basePayload.selling_price = optionalNumber(sellingPrice);
    if (!product || unit !== initialUnit) basePayload.unit = unit;

    const { data: savedRow, error } = product
      ? await supabase.from("products").update(basePayload).eq("id", product.id).eq("store_id", storeId).select().single()
      : await supabase.from("products").insert({ ...basePayload, stock_quantity: optionalNumber(stockQuantity) ?? 0 }).select().single();
    if (error) {
      setSaving(false);
      return toast.error(mapProductError(error));
    }

    let finalRow = savedRow as ProductRow;
    if (product) {
      const newQty = optionalNumber(stockQuantity) ?? 0;
      const delta = newQty - Number(product.stock_quantity);
      if (Number.isFinite(delta) && delta !== 0) {
        const { data: adjustedRow, error: adjustError } = await adjustStock({
          _product_id: product.id,
          _store_id: storeId,
          _delta: delta,
          _reason: "manual",
          _reference_type: "product_fiche",
        });
        if (adjustError) {
          setSaving(false);
          toast.error(`تم حفظ بيانات المنتج، لكن تعذر تحديث الكمية: ${adjustError.message}`);
          onSaved(finalRow);
          return;
        }
        if (adjustedRow) finalRow = adjustedRow;
      }
    }

    setSaving(false);
    toast.success(product ? "تم تحديث المنتج." : "تزاد المنتج بنجاح.");
    onSaved(finalRow);
  }

  // Every code this product answers to, as label options: the main
  // barcode (as currently typed), each extra barcode, each active variant
  // with a barcode (its label also carries the variant name).
  const labelOptions = useMemo(() => {
    const options: Array<{ key: string; label: string; value: string; variantName: string | null }> = [];
    if (barcode.trim()) options.push({ key: "main", label: `الأساسي — ${barcode.trim()}`, value: barcode.trim(), variantName: null });
    for (const b of extraBarcodes) {
      options.push({ key: `extra:${b.id}`, label: `إضافي — ${b.barcode}${b.note ? ` (${b.note})` : ""}`, value: b.barcode, variantName: null });
    }
    for (const v of variants) {
      if (!v.is_active || !v.barcode) continue;
      options.push({ key: `variant:${v.id}`, label: `تنويعة ${v.variant_name} — ${v.barcode}`, value: v.barcode, variantName: v.variant_name });
    }
    return options;
  }, [barcode, extraBarcodes, variants]);
  const labelTarget = labelOptions.find((o) => o.key === labelChoice) ?? labelOptions[0] ?? null;

  // Real, scannable CODE128 rendering (Phase A item 2) — recomputed
  // synchronously (canvas-based, no network/async step) whenever the
  // chosen code changes, so the preview below and the printed label
  // always show the exact same image.
  const barcodeDataUrl = useMemo(() => (labelTarget ? generateBarcodeDataUrl(labelTarget.value) : null), [labelTarget]);

  /** Prints `labelCount` copies of one label at the product's own
   * label_size (mm) via the shared offscreen-print IPC path (item 3) —
   * same helper item 1's receipt printing uses, not a parallel system. */
  async function printLabels() {
    const count = Math.max(1, Math.min(200, Number(labelCount) || 1));
    if (!name.trim()) return toast.error("أدخل اسم المنتج أولًا.");
    if (!window.suma?.printLabel) {
      toast.error("الطباعة غير متوفرة في هذه البيئة.");
      return;
    }
    const { widthMm, heightMm } = parseLabelSize(labelSize);
    const price = optionalNumber(sellingPrice);
    const html = buildLabelHtml({
      productName: name.trim(),
      variantName: labelTarget?.variantName ?? null,
      price: price !== null && Number.isFinite(price) ? price : null,
      barcodeValue: labelTarget?.value ?? null,
      barcodeDataUrl,
      widthMm,
      heightMm,
    });
    setPrintingLabel(true);
    const res = await window.suma.printLabel(html, { widthMm, heightMm, copies: count });
    setPrintingLabel(false);
    if (!res.ok) toast.error("تعذرت طباعة الملصق — تحقق من الطابعة الافتراضية.");
  }

  const tabs: Array<{ key: SecondaryTab; label: string }> = [
    { key: "packaging", label: "التغليف" },
    { key: "specifications", label: "المواصفات" },
    { key: "sizes", label: "المقاسات / الأحجام" },
    { key: "expiry", label: "الصلاحية" },
  ];

  return (
    <>
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 print:hidden" onClick={onClose}>
      <div
        className="surface flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden"
        style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
      <header
        className="flex cursor-move select-none items-center gap-3 border-b border-border px-4 py-3"
        onMouseDown={startDrag}
        title="اسحب لتحريك النافذة"
      >
        <h1 className="text-lg font-bold">{!product ? "إضافة منتج" : canWrite ? "تعديل منتج" : "بطاقة المنتج"}</h1>
        <Button variant="ghost" size="icon" className="ms-auto" onClick={onClose} aria-label="إغلاق">
          <X className="size-5" aria-hidden />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Read-only for members without write access: the fields are shown
              (SUMA Web's product page is readable by every member) but can't
              be edited. `contents` keeps the sections in the grid. */}
          <fieldset disabled={!canWrite} className="contents">
          {/* الأساسية */}
          <section className="surface overflow-hidden p-0">
            <h2 className="bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">المعلومات الأساسية</h2>
            <div className="grid gap-3 p-4">
              <div className="flex items-center gap-3">
                <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed border-border bg-muted">
                  {imageUrl ? <img src={imageUrl} alt="" className="size-full object-cover" /> : <span className="text-[9px] text-muted-foreground">بلا صورة</span>}
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleImageFile(file);
                    }}
                  />
                  <Button type="button" variant="outline" size="sm" disabled={uploadingImage} onClick={() => imageInputRef.current?.click()}>
                    {uploadingImage ? "جاري الرفع..." : imageUrl ? "بدّل الصورة" : "ارفع صورة"}
                  </Button>
                  {imageUrl && !uploadingImage && (
                    // Same as SUMA Web's "احذف الصورة": clears image_url on save.
                    <button type="button" className="text-start text-xs text-destructive disabled:opacity-50" onClick={() => setImageUrl(null)}>
                      احذف الصورة
                    </button>
                  )}
                </div>
              </div>

              <div>
                <Label htmlFor="f-name">اسم المنتج *</Label>
                <Input id="f-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={NAME_MAX} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="f-ref">المرجع (الكود الداخلي)</Label>
                  <div className="flex gap-2">
                    <Input id="f-ref" value={internalCode} onChange={(e) => setInternalCode(e.target.value)} dir="ltr" maxLength={INTERNAL_CODE_MAX} />
                    <Button type="button" variant="outline" size="icon" disabled={generatingCode} onClick={() => void generateCode()}>
                      {generatingCode ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wand2 className="size-4" aria-hidden />}
                    </Button>
                  </div>
                </div>
                <div>
                  <Label htmlFor="f-barcode">Barcode</Label>
                  <Input id="f-barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} dir="ltr" maxLength={64} />
                  {!validateBarcode(barcode).ok && (
                    <p className="mt-1 text-[11px] text-destructive">حروف لاتينية وأرقام و - و _ فقط.</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="f-cat">الفئة / التصنيف</Label>
                  <select id="f-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                    <option value="">بلا تصنيف</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="f-brand">الماركة</Label>
                  <Input id="f-brand" value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} />
                </div>
              </div>

              <div>
                <Label htmlFor="f-type">نوع المنتج</Label>
                <Input id="f-type" value={productType} onChange={(e) => setProductType(e.target.value)} maxLength={80} placeholder="مثلًا: منتج ألبان، مشروب غازي..." />
              </div>

              <div>
                <Label htmlFor="f-desc">الوصف</Label>
                <textarea
                  id="f-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  maxLength={DESCRIPTION_MAX}
                  placeholder="وصف قصير يظهر للزبائن (اختياري)"
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <p className="mt-0.5 text-end text-[10px] text-muted-foreground num">
                  {description.length}/{DESCRIPTION_MAX}
                </p>
              </div>
            </div>
          </section>

          {/* الأسعار */}
          <section className="surface overflow-hidden p-0">
            <h2 className="bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">الأسعار</h2>
            <div className="grid gap-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="f-purchase">سعر الشراء (دج)</Label>
                  <Input id="f-purchase" type="number" step="0.01" min="0" max={PRICE_MAX} value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="f-selling">سعر البيع (دج) *</Label>
                  <Input
                    id="f-selling"
                    type="number"
                    step="0.01"
                    min="0"
                    max={PRICE_MAX}
                    value={sellingPrice}
                    disabled={priceLocked}
                    title={priceLocked ? "تغيير السعر محجوز لصاحب المحل" : undefined}
                    onChange={(e) => setSellingPrice(e.target.value)}
                  />
                  {priceLocked && <p className="mt-1 text-[11px] text-muted-foreground">تغيير السعر محجوز لصاحب المحل</p>}
                </div>
              </div>
              <div>
                <Label htmlFor="f-points">نقاط الولاء لكل وحدة</Label>
                <Input id="f-points" type="number" step="1" min="0" max={POINTS_MAX} value={pointsReward} onChange={(e) => setPointsReward(e.target.value)} />
                <p className="mt-1 text-[11px] text-muted-foreground">تُضاف لرصيد الزبون عند كل بيع لهذا المنتج (0 = بدون نقاط).</p>
              </div>
              <div>
                <Label htmlFor="f-tax">الضريبة (%)</Label>
                <Input id="f-tax" type="number" step="0.01" min="0" max="100" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} placeholder="افتراضي المحل إذا تُرك فارغًا" />
              </div>
              <p className="text-xs text-muted-foreground">
                أكثر من سعر بيع (جملة/تجزئة...) غير مدعوم بعد — سعر بيع واحد لكل منتج حاليًا.
              </p>
            </div>
          </section>

          {/* المخزون */}
          <section className="surface overflow-hidden p-0">
            <h2 className="bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">المخزون</h2>
            <div className="grid gap-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="f-stock">المخزون الحالي</Label>
                  <Input id="f-stock" type="number" step="0.01" value={stockQuantity} onChange={(e) => setStockQuantity(e.target.value)} />
                  {product && Number.isFinite(Number(stockQuantity)) && Number(stockQuantity) !== Number(product.stock_quantity) && (
                    <p className="mt-1 text-xs font-semibold text-[var(--primary)]">
                      {Number(stockQuantity) > Number(product.stock_quantity) ? "+" : ""}
                      {Number(stockQuantity) - Number(product.stock_quantity)} عند الحفظ — يُسجَّل كحركة مخزون
                    </p>
                  )}
                </div>
                <div>
                  <Label htmlFor="f-low">حد تنبيه المخزون</Label>
                  <Input id="f-low" type="number" step="1" min="0" value={lowStockThreshold} onChange={(e) => setLowStockThreshold(e.target.value)} />
                </div>
              </div>
              <div>
                <Label htmlFor="f-loc">موقع المنتج داخل المحل</Label>
                <Input id="f-loc" value={locationInStore} onChange={(e) => setLocationInStore(e.target.value)} placeholder="رف 3، ممر الألبان..." maxLength={80} />
              </div>
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setIsActive((v) => !v)}
                  className={`h-6 w-11 rounded-full transition-colors ${isActive ? "bg-[var(--primary)]" : "bg-[var(--muted)]"}`}
                  aria-label="المنتج مفعّل"
                >
                  <span className={`block size-5 rounded-full bg-white shadow transition-transform ${isActive ? "translate-x-0.5" : "translate-x-5"}`} />
                </button>
                <Label>المنتج مفعّل</Label>
              </div>
            </div>
          </section>

          {/* طريقة البيع */}
          <section className="surface overflow-hidden p-0">
            <h2 className="bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">طريقة البيع</h2>
            <div className="grid gap-3 p-4">
              <div className="grid grid-cols-3 gap-2">
                <Button type="button" variant={saleMethod === "piece" ? "default" : "outline"} size="sm" onClick={() => selectSaleMethod("piece")}>
                  بالقطعة
                </Button>
                <Button type="button" variant={saleMethod === "weight" ? "default" : "outline"} size="sm" onClick={() => selectSaleMethod("weight")}>
                  بالوزن
                </Button>
                <Button type="button" variant={saleMethod === "measure" ? "default" : "outline"} size="sm" onClick={() => selectSaleMethod("measure")}>
                  حسب وحدة القياس
                </Button>
              </div>
              <div>
                <Label htmlFor="f-unit">
                  {saleMethod === "piece" ? "وحدة البيع" : saleMethod === "weight" ? "وحدة الوزن" : "وحدة القياس"}
                </Label>
                <select id="f-unit" value={unit} onChange={(e) => setUnit(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  {unitOptions(saleMethod).map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          </fieldset>

          {/* الباركود */}
          <ExtraBarcodesSection
            storeId={storeId}
            productId={product?.id ?? null}
            rows={extraBarcodes}
            onRowsChange={setExtraBarcodes}
            canManage={perms.canManageProducts}
            disabledReason={offlineReason}
          />

          {product && <PriceHistorySection productId={product.id} />}

          {/* آخر الحركات والمشتريات — read-only, only meaningful once the
              product actually exists and has history. */}
          {product && (
            <section className="surface overflow-hidden p-0">
              <h2 className="flex items-center gap-2 bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">
                <History className="size-4" aria-hidden />
                آخر الحركات
              </h2>
              <div className="p-4">
                {lastPurchase && (
                  <div className="mb-3 rounded-lg bg-[var(--muted)] p-2.5 text-xs">
                    <p className="font-semibold">آخر شراء</p>
                    <p className="mt-0.5 text-muted-foreground">
                      {lastPurchase.supplierName ?? "بدون مورد"} — {formatDA(lastPurchase.cost)} — {formatDateTime(lastPurchase.date)}
                    </p>
                  </div>
                )}
                {recentMovements.length === 0 ? (
                  <p className="text-xs text-muted-foreground">ما كانش أي حركة مسجّلة لهذا المنتج بعد.</p>
                ) : (
                  <ul className="grid gap-1.5">
                    {recentMovements.map((m) => (
                      <li key={m.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="shrink-0 rounded-full bg-[var(--muted)] px-2 py-0.5 font-semibold">{REASON_LABEL[m.reason] ?? m.reason}</span>
                        <span className="num text-muted-foreground">
                          {m.quantity_before} ← {m.quantity_after} ({Number(m.delta) > 0 ? "+" : ""}
                          {m.delta})
                        </span>
                        <span className="shrink-0 text-muted-foreground">{formatDateTime(m.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          <VariantsSection
            storeId={storeId}
            productId={product?.id ?? null}
            variants={variants}
            onVariantsChange={setVariants}
            canManage={perms.canManageProducts}
            canDelete={perms.isAdmin}
            disabledReason={offlineReason}
          />

          {/* الملصق والطباعة */}
          <section className="surface overflow-hidden p-0">
            <h2 className="bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">الملصق والطباعة</h2>
            <div className="grid gap-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="f-label-size">مقاس الملصق</Label>
                  <select id="f-label-size" value={labelSize} onChange={(e) => setLabelSize(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                    {LABEL_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="f-label-count">عدد الملصقات</Label>
                  <Input id="f-label-count" type="number" min="1" max="200" value={labelCount} onChange={(e) => setLabelCount(e.target.value)} />
                </div>
              </div>
              {labelOptions.length > 1 && (
                <div>
                  <Label htmlFor="f-label-code">الباركود المطبوع</Label>
                  <select
                    id="f-label-code"
                    value={labelTarget?.key ?? ""}
                    onChange={(e) => setLabelChoice(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {labelOptions.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {labelTarget && (
                <div className="grid place-items-center rounded-lg border border-dashed border-border bg-muted/40 p-2">
                  {barcodeDataUrl ? (
                    <img src={barcodeDataUrl} alt="معاينة الباركود" className="max-h-16" />
                  ) : (
                    <p className="text-xs text-destructive">تعذّر توليد باركود قابل للمسح لهذه القيمة.</p>
                  )}
                </div>
              )}
              <Button type="button" variant="outline" disabled={printingLabel} onClick={() => void printLabels()}>
                {printingLabel ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Printer className="size-4" aria-hidden />}
                طباعة {Math.max(1, Math.min(200, Number(labelCount) || 1)) > 1 ? `(${labelCount} نسخة)` : ""}
              </Button>
              <p className="text-xs text-muted-foreground">
                يطبع الملصق باركودًا حقيقيًا قابلاً للمسح الضوئي بمقاس {labelSize}، بالإضافة لاسم المنتج
                {labelTarget?.variantName ? ` والتنويعة (${labelTarget.variantName})` : ""} والسعر.
              </p>
            </div>
          </section>

          {/* Secondary tabs */}
          <section className="surface overflow-hidden p-0 lg:col-span-2">
            <div className="flex border-b border-border">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setActiveTab(t.key)}
                  className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                    activeTab === t.key ? "border-b-2 border-[var(--primary)] text-[var(--primary)]" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <fieldset disabled={!canWrite} className="p-4">
              {activeTab === "packaging" && (
                <textarea
                  value={packaging}
                  onChange={(e) => setPackaging(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="طريقة التغليف، عدد القطع في الكرطونة..."
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              )}
              {activeTab === "specifications" && (
                <textarea
                  value={specifications}
                  onChange={(e) => setSpecifications(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="مواصفات إضافية عن المنتج..."
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              )}
              {activeTab === "sizes" && (
                <textarea
                  value={sizes}
                  onChange={(e) => setSizes(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="المقاسات أو الأحجام المتوفرة (S/M/L، 250مل/500مل...)"
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              )}
              {activeTab === "expiry" && (
                <div className="max-w-xs">
                  <Label htmlFor="f-expiry">تاريخ الصلاحية</Label>
                  <Input id="f-expiry" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
                  <p className="mt-1 text-xs text-muted-foreground">اختياري — لمنتجات كالألبان والخبز.</p>
                </div>
              )}
            </fieldset>
          </section>
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border p-4">
        {(!isOnline || !canWrite) && (
          <p className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
            {!isOnline && <CloudOff className="size-3.5 shrink-0" aria-hidden />}
            {!isOnline
              ? "غير متصل — حفظ المنتج والباركودات والتنويعات يحتاج اتصالاً بالإنترنت."
              : product
                ? "تعديل المنتجات يحتاج صلاحية إدارة المنتجات."
                : "إضافة منتج جديد محجوزة لصاحب المحل والمدير."}
          </p>
        )}
        <Button variant="outline" className="flex-1" onClick={onClose}>
          إلغاء
        </Button>
        <Button className="flex-1" size="lg" disabled={saving || !isOnline || !canWrite} onClick={() => void save()}>
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
          حفظ المنتج
        </Button>
      </footer>
      </div>
    </div>
    </>
  );
}
