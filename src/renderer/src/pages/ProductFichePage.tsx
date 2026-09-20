import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Printer, Trash2, Wand2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { CategoryRow, ProductBarcodeRow, ProductRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const WEIGHT_UNITS = ["كغ", "غرام"];
const MEASURE_UNITS = ["لتر", "مل", "متر", "علبة", "كرطونة", "باكيتة"];
const LABEL_SIZES = ["80×50 مم", "58×40 مم", "40×30 مم"];

type SaleMethod = "piece" | "weight" | "measure";

function methodFromUnit(unit: string): SaleMethod {
  if (WEIGHT_UNITS.includes(unit)) return "weight";
  if (MEASURE_UNITS.includes(unit)) return "measure";
  return "piece";
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

function mapProductError(message: string): string {
  if (message.includes("uq_products_store_barcode") || message.includes("uq_product_barcodes_store_barcode")) {
    return "هذا الباركود مستعمل من قبل في محلك.";
  }
  if (message.includes("uq_products_store_internal")) {
    return "الكود الداخلي مستعمل من قبل في محلك.";
  }
  if (message.toLowerCase().includes("row-level security")) {
    return "ما عندكش الصلاحية باش تدير هذا التغيير.";
  }
  return message;
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

  const [unit, setUnit] = useState(product?.unit ?? "قطعة");
  const [saleMethod, setSaleMethod] = useState<SaleMethod>(methodFromUnit(product?.unit ?? "قطعة"));

  const [labelSize, setLabelSize] = useState(product?.label_size ?? LABEL_SIZES[0]);
  const [labelCount, setLabelCount] = useState("1");
  const [labelPrintCount, setLabelPrintCount] = useState(1);

  const [packaging, setPackaging] = useState(product?.packaging ?? "");
  const [specifications, setSpecifications] = useState(product?.specifications ?? "");
  const [sizes, setSizes] = useState(product?.sizes ?? "");
  const [expiryDate, setExpiryDate] = useState(product?.expiry_date ?? "");
  const [activeTab, setActiveTab] = useState<SecondaryTab>("packaging");

  const [extraBarcodes, setExtraBarcodes] = useState<ProductBarcodeRow[]>([]);
  const [newExtraBarcode, setNewExtraBarcode] = useState("");

  const [pointsReward] = useState(product?.points_reward ?? 0);
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
    if (product) void loadExtraBarcodes(product.id);
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

  async function addExtraBarcode() {
    const code = newExtraBarcode.trim();
    if (!code || !product) return;
    const { error } = await supabase.from("product_barcodes").insert({ product_id: product.id, store_id: storeId, barcode: code });
    if (error) return toast.error(mapProductError(error.message));
    setNewExtraBarcode("");
    void loadExtraBarcodes(product.id);
  }

  async function removeExtraBarcode(id: string) {
    const { error } = await supabase.from("product_barcodes").delete().eq("id", id);
    if (error) return toast.error(error.message);
    if (product) void loadExtraBarcodes(product.id);
  }

  function selectSaleMethod(method: SaleMethod) {
    setSaleMethod(method);
    if (method === "piece") setUnit("قطعة");
    else if (method === "weight") setUnit(WEIGHT_UNITS[0]);
    else setUnit(MEASURE_UNITS[0]);
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
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const isImage = file.type.startsWith("image/") || ext in IMAGE_MIME_BY_EXT;
    if (!isImage) return toast.error("لازم تختار صورة.");
    if (file.size > 5 * 1024 * 1024) return toast.error("الصورة كبيرة برشا (أقصى 5 ميغا).");
    setUploadingImage(true);
    const path = `${storeId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from("product-images")
      .upload(path, file, { upsert: true, contentType: file.type || IMAGE_MIME_BY_EXT[ext] || "application/octet-stream" });
    setUploadingImage(false);
    if (error) return toast.error(error.message || "ما قدرناش نرفعو الصورة.");
    const { data } = supabase.storage.from("product-images").getPublicUrl(path);
    setImageUrl(data.publicUrl);
  }

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) return toast.error("لازم اسم للمنتج.");
    const selling = Number(sellingPrice);
    if (!(selling >= 0)) return toast.error("سعر البيع لازم يكون رقم.");

    const trimmedBarcode = barcode.trim() || null;
    if (trimmedBarcode) {
      const { data: aliasHit } = await supabase
        .from("product_barcodes")
        .select("product_id, products(name)")
        .eq("store_id", storeId)
        .eq("barcode", trimmedBarcode)
        .neq("product_id", product?.id ?? "00000000-0000-0000-0000-000000000000")
        .maybeSingle();
      if (aliasHit) {
        const otherName = (aliasHit as unknown as { products: { name: string } | null }).products?.name ?? "";
        return toast.error(`هذا الباركود مستخدم بالفعل كباركود إضافي لمنتج آخر: ${otherName}.`);
      }
    }

    const payload = {
      store_id: storeId,
      name: trimmedName,
      barcode: trimmedBarcode,
      internal_code: internalCode.trim() || null,
      category_id: categoryId || null,
      brand: brand.trim() || null,
      product_type: productType.trim() || null,
      image_url: imageUrl,
      purchase_price: purchasePrice.trim() ? Number(purchasePrice) : null,
      selling_price: selling,
      tax_rate: taxRate.trim() ? Number(taxRate) : null,
      stock_quantity: stockQuantity.trim() ? Number(stockQuantity) : 0,
      low_stock_threshold: lowStockThreshold.trim() ? Number(lowStockThreshold) : 5,
      location_in_store: locationInStore.trim() || null,
      unit,
      label_size: labelSize || null,
      packaging: packaging.trim() || null,
      specifications: specifications.trim() || null,
      sizes: sizes.trim() || null,
      expiry_date: expiryDate.trim() || null,
      points_reward: pointsReward,
      is_active: isActive,
    };

    setSaving(true);
    const { data: savedRow, error } = product
      ? await supabase.from("products").update(payload).eq("id", product.id).eq("store_id", storeId).select().single()
      : await supabase.from("products").insert(payload).select().single();
    setSaving(false);
    if (error) return toast.error(mapProductError(error.message));
    toast.success(product ? "تم تحديث المنتج." : "تزاد المنتج بنجاح.");
    onSaved(savedRow as ProductRow);
  }

  function printLabels() {
    const count = Math.max(1, Math.min(200, Number(labelCount) || 1));
    if (!name.trim()) return toast.error("أدخل اسم المنتج أولًا.");
    setLabelPrintCount(count);
    setTimeout(() => window.print(), 50);
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
        <h1 className="text-lg font-bold">{product ? "تعديل منتج" : "إضافة منتج"}</h1>
        <Button variant="ghost" size="icon" className="ms-auto" onClick={onClose} aria-label="إغلاق">
          <X className="size-5" aria-hidden />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid gap-4 lg:grid-cols-2">
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
                </div>
              </div>

              <div>
                <Label htmlFor="f-name">اسم المنتج *</Label>
                <Input id="f-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="f-ref">المرجع (الكود الداخلي)</Label>
                  <div className="flex gap-2">
                    <Input id="f-ref" value={internalCode} onChange={(e) => setInternalCode(e.target.value)} dir="ltr" />
                    <Button type="button" variant="outline" size="icon" disabled={generatingCode} onClick={() => void generateCode()}>
                      {generatingCode ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wand2 className="size-4" aria-hidden />}
                    </Button>
                  </div>
                </div>
                <div>
                  <Label htmlFor="f-barcode">Barcode</Label>
                  <Input id="f-barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} inputMode="numeric" dir="ltr" />
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
            </div>
          </section>

          {/* الأسعار */}
          <section className="surface overflow-hidden p-0">
            <h2 className="bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">الأسعار</h2>
            <div className="grid gap-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="f-purchase">سعر الشراء (دج)</Label>
                  <Input id="f-purchase" type="number" step="0.01" min="0" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="f-selling">سعر البيع (دج) *</Label>
                  <Input id="f-selling" type="number" step="0.01" min="0" value={sellingPrice} onChange={(e) => setSellingPrice(e.target.value)} />
                </div>
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
              {saleMethod === "weight" && (
                <div>
                  <Label htmlFor="f-unit-weight">وحدة الوزن</Label>
                  <select id="f-unit-weight" value={unit} onChange={(e) => setUnit(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                    {WEIGHT_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {saleMethod === "measure" && (
                <div>
                  <Label htmlFor="f-unit-measure">وحدة القياس</Label>
                  <select id="f-unit-measure" value={unit} onChange={(e) => setUnit(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                    {MEASURE_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </section>

          {/* الباركود */}
          <section className="surface overflow-hidden p-0">
            <h2 className="bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">باركودات إضافية</h2>
            <div className="p-4">
              {!product ? (
                <p className="text-xs text-muted-foreground">احفظ المنتج أولًا لتقدر تضيف باركودات إضافية له.</p>
              ) : (
                <>
                  <div className="flex gap-2">
                    <Input value={newExtraBarcode} onChange={(e) => setNewExtraBarcode(e.target.value)} placeholder="باركود إضافي..." dir="ltr" inputMode="numeric" />
                    <Button type="button" variant="outline" onClick={() => void addExtraBarcode()}>
                      <Plus className="size-4" aria-hidden />
                    </Button>
                  </div>
                  {extraBarcodes.length > 0 && (
                    <ul className="mt-2 divide-y divide-border">
                      {extraBarcodes.map((b) => (
                        <li key={b.id} className="flex items-center justify-between py-1.5 text-sm">
                          <span className="num" dir="ltr">
                            {b.barcode}
                          </span>
                          <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => void removeExtraBarcode(b.id)}>
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </section>

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
              <Button type="button" variant="outline" onClick={printLabels}>
                <Printer className="size-4" aria-hidden />
                طباعة
              </Button>
              <p className="text-xs text-muted-foreground">
                الملصق يطبع اسم المنتج والسعر ورقم الباركود كنص — رسم باركود قابل للمسح الضوئي غير مدعوم بعد.
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
            <div className="p-4">
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
            </div>
          </section>
        </div>
      </div>

      <footer className="flex items-center gap-2 border-t border-border p-4">
        <Button variant="outline" className="flex-1" onClick={onClose}>
          إلغاء
        </Button>
        <Button className="flex-1" size="lg" disabled={saving} onClick={() => void save()}>
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
          حفظ المنتج
        </Button>
      </footer>
      </div>
    </div>

    {/* Print-only label sheet — hidden on screen, shown only in @media print (styles.css) */}
    <div className="hidden print:grid print:grid-cols-2 print:gap-2">
      {Array.from({ length: labelPrintCount }, (_, i) => (
        <div key={i} className="border border-black p-2 text-center">
          <p className="text-xs font-bold">{name}</p>
          <p className="text-[10px] num" dir="ltr">
            {barcode || "—"}
          </p>
          <p className="text-sm font-black num">{sellingPrice ? `${sellingPrice} دج` : ""}</p>
        </div>
      ))}
    </div>
    </>
  );
}
