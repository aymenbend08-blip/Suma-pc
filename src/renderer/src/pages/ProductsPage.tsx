import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  FolderPlus,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Wand2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useStore } from "@/context/StoreContext";
import { formatDA } from "@/lib/format";
import type { CategoryRow, ProductRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const UNITS = ["وحدة", "كغ", "غرام", "لتر", "مل", "علبة", "كرطونة", "متر", "باكيتة"];
const PAGE_SIZE = 20;

type FilterKind = "all" | "active" | "inactive" | "low_stock" | "out_of_stock" | "expiring_soon";

/** Same Postgres constraint names SUMA Web's mapProductError() translates —
 * a duplicate barcode/internal_code surfaces through PostgREST identically
 * whether the insert/update comes from the web server function or straight
 * from this authenticated client, so the same mapping applies unchanged. */
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

/**
 * A straight port of SUMA Web's المنتجات screen (products.index.tsx +
 * product-form.tsx) onto the same RLS-scoped Supabase client every other
 * Desktop screen already uses — same filters, same fields, same duplicate-
 * barcode/internal-code checks, same category management. Two things
 * SUMA Web's server functions do that this can't replicate: writing to
 * audit_log and pushing owner notifications both go through the
 * service-role client there (see audit.server.ts) — Desktop has no
 * service-role key by design, so those two side effects are silently
 * skipped here rather than faked. Everything that changes actual data
 * (insert/update/delete, the barcode/internal-code uniqueness checks,
 * category CRUD) is unchanged.
 *
 * Also intentionally deferred, each its own sizable feature on Web: the
 * camera barcode scanner (a USB/keyboard-wedge scanner typing into the
 * barcode field already works, which is the normal Desktop setup anyway),
 * Excel export/import, and the product detail/price-history page.
 */
export function ProductsPage() {
  const { active, perms } = useStore();
  const storeId = active!.id;

  const [rows, setRows] = useState<ProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<CategoryRow[]>([]);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");
  const [categoryId, setCategoryId] = useState("");
  const [page, setPage] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [catOpen, setCatOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProductRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  async function loadCategories() {
    const { data, error } = await supabase.from("categories").select("*").eq("store_id", storeId).order("sort_order");
    if (error) return toast.error(error.message);
    setCategories(data ?? []);
  }

  async function loadProducts() {
    setLoading(true);
    const from = page * PAGE_SIZE;
    const term = debouncedSearch.replace(/[%,]/g, " ").trim();

    let aliasIds: string[] | null = null;
    if (term && /^[A-Za-z0-9\-_]+$/.test(term)) {
      const { data: aliasRows } = await supabase
        .from("product_barcodes")
        .select("product_id")
        .eq("store_id", storeId)
        .ilike("barcode", `%${term}%`);
      aliasIds = (aliasRows ?? []).map((r) => r.product_id);
    }

    let query = supabase
      .from("products")
      .select("*", { count: "exact" })
      .eq("store_id", storeId)
      .range(from, from + PAGE_SIZE - 1);

    if (term) {
      const orParts = [`name.ilike.%${term}%`, `barcode.ilike.%${term}%`, `internal_code.ilike.%${term}%`];
      if (aliasIds && aliasIds.length > 0) orParts.push(`id.in.(${aliasIds.join(",")})`);
      query = query.or(orParts.join(","));
    }
    if (priceMin) query = query.gte("selling_price", Number(priceMin));
    if (priceMax) query = query.lte("selling_price", Number(priceMax));
    if (categoryId) query = query.eq("category_id", categoryId);
    if (filter === "active") query = query.eq("is_active", true);
    if (filter === "inactive") query = query.eq("is_active", false);
    if (filter === "out_of_stock") query = query.lte("stock_quantity", 0);
    if (filter === "low_stock") query = query.eq("is_low_stock", true);
    if (filter === "expiring_soon") {
      const sevenDaysAhead = new Date();
      sevenDaysAhead.setDate(sevenDaysAhead.getDate() + 7);
      query = query.not("expiry_date", "is", null).lte("expiry_date", sevenDaysAhead.toISOString().slice(0, 10));
    }
    query =
      filter === "expiring_soon"
        ? query.order("expiry_date", { ascending: true })
        : query.order("updated_at", { ascending: false });

    const { data, error, count } = await query;
    setLoading(false);
    if (error) return toast.error(error.message);
    setRows(data ?? []);
    setTotal(count ?? 0);
  }

  useEffect(() => {
    void loadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    void loadProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, debouncedSearch, priceMin, priceMax, filter, categoryId, page]);

  function categoryName(id: string | null): string {
    return categories.find((c) => c.id === id)?.name ?? "بلا تصنيف";
  }

  async function toggleActive(row: ProductRow) {
    const { error } = await supabase
      .from("products")
      .update({ is_active: !row.is_active })
      .eq("id", row.id)
      .eq("store_id", storeId);
    if (error) return toast.error(mapProductError(error.message));
    toast.success("تم تحديث حالة المنتج.");
    void loadProducts();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase.from("products").delete().eq("id", deleteTarget.id).eq("store_id", storeId);
    setDeleting(false);
    if (error) return toast.error(mapProductError(error.message));
    toast.success("تم حذف المنتج.");
    setDeleteTarget(null);
    void loadProducts();
  }

  async function confirmClearAll() {
    setClearing(true);
    const { data, error } = await supabase.from("products").delete().eq("store_id", storeId).select("id");
    setClearing(false);
    if (error) return toast.error(error.message);
    setClearOpen(false);
    toast.success(`تمت تصفية المنتجات — تمت إزالة ${data?.length ?? 0} منتجًا.`);
    void loadProducts();
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">المنتجات</h1>
          <p className="text-xs text-muted-foreground num">{total} منتج</p>
        </div>
        {perms.canManageProducts && (
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="size-4" aria-hidden />
            منتج جديد
          </Button>
        )}
      </div>

      <div className="surface flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-48 flex-1">
          <Label htmlFor="q">البحث بالاسم / الباركود / الكود الداخلي</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 end-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id="q" value={search} onChange={(e) => setSearch(e.target.value)} className="pe-9" placeholder="حليب، 1234567890123، S123456" />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="w-24">
            <Label htmlFor="priceMin">السعر من</Label>
            <Input
              id="priceMin"
              type="number"
              min="0"
              value={priceMin}
              onChange={(e) => {
                setPriceMin(e.target.value);
                setPage(0);
              }}
              placeholder="0"
            />
          </div>
          <div className="w-24">
            <Label htmlFor="priceMax">إلى</Label>
            <Input
              id="priceMax"
              type="number"
              min="0"
              value={priceMax}
              onChange={(e) => {
                setPriceMax(e.target.value);
                setPage(0);
              }}
              placeholder="∞"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="filter">الحالة</Label>
          <select
            id="filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as FilterKind);
              setPage(0);
            }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="all">الكل</option>
            <option value="active">مفعّل</option>
            <option value="inactive">معطّل</option>
            <option value="low_stock">مخزون ناقص</option>
            <option value="out_of_stock">كمل</option>
            <option value="expiring_soon">قريب من انتهاء الصلاحية</option>
          </select>
        </div>
        <div>
          <Label htmlFor="cat">التصنيف</Label>
          <select
            id="cat"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(0);
            }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">كل التصنيفات</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {perms.isAdmin && (
          <Button variant="outline" onClick={() => setCatOpen(true)}>
            <FolderPlus className="size-4" aria-hidden />
            التصنيفات
          </Button>
        )}
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">جاري التحميل...</p>
      ) : rows.length === 0 ? (
        <p className="surface py-8 text-center text-sm text-muted-foreground">ما كانش منتجات</p>
      ) : (
        <>
          <ul className="grid gap-3">
            {rows.map((row) => {
              const stock = Number(row.stock_quantity);
              const low = Number(row.low_stock_threshold);
              return (
                <li key={row.id} className="surface flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold">{row.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{categoryName(row.category_id)}</span>
                      {row.barcode && <span className="num">• {row.barcode}</span>}
                      {row.internal_code && <span className="num">• {row.internal_code}</span>}
                      <span>
                        •{" "}
                        {stock <= 0 ? (
                          <span className="rounded-full bg-[var(--destructive)] px-1.5 py-0.5 text-[10px] font-bold text-white">
                            كمل
                          </span>
                        ) : stock <= low ? (
                          <span className="rounded-full bg-[var(--warning)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--warning-foreground)] num">
                            مخزون ناقص ({stock})
                          </span>
                        ) : (
                          <span className="num">
                            المخزون: {stock} {row.unit}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="text-lg font-black num">{formatDA(row.selling_price)}</div>
                  {perms.canManageProducts && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void toggleActive(row)}
                        className={`h-6 w-11 rounded-full transition-colors ${row.is_active ? "bg-[var(--primary)]" : "bg-[var(--muted)]"}`}
                        aria-label="تفعيل / تعطيل"
                      >
                        <span
                          className={`block size-5 rounded-full bg-white shadow transition-transform ${row.is_active ? "translate-x-0.5" : "translate-x-5"}`}
                        />
                      </button>
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label="تعديل"
                        onClick={() => {
                          setEditing(row);
                          setFormOpen(true);
                        }}
                      >
                        <Pencil className="size-4" aria-hidden />
                      </Button>
                      <Button size="icon" variant="outline" aria-label="حذف" onClick={() => setDeleteTarget(row)}>
                        <Trash2 className="size-4 text-destructive" aria-hidden />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between gap-3">
              <Button variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                السابق
              </Button>
              <span className="text-sm text-muted-foreground num">
                صفحة {page + 1} من {totalPages}
              </span>
              <Button variant="outline" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>
                التالي
              </Button>
            </div>
          )}
        </>
      )}

      {perms.isAdmin && total > 0 && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <h2 className="mb-1 flex items-center gap-1.5 text-sm font-bold text-destructive">
            <AlertTriangle className="size-4" aria-hidden />
            منطقة خطرة
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            تصفية كل منتجات هذا المحل — مفيدة لو حابب تبدأ من جديد.
          </p>
          <Button variant="destructive" size="sm" onClick={() => setClearOpen(true)}>
            <Trash2 className="size-4" aria-hidden />
            تصفية جميع المنتجات
          </Button>
        </div>
      )}

      {formOpen && (
        <ProductFormDialog
          storeId={storeId}
          product={editing}
          categories={categories}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            setFormOpen(false);
            setEditing(null);
            void loadProducts();
          }}
        />
      )}

      {catOpen && <CategoriesDialog storeId={storeId} categories={categories} onClose={() => setCatOpen(false)} onChanged={loadCategories} />}

      {deleteTarget && (
        <ConfirmDialog
          title={`تحذف «${deleteTarget.name}»؟`}
          description="سيبقى هذا المنتج مرتبطًا بأي مبيعات سابقة، لكن لا يمكن التراجع عن حذفه من قائمة المنتجات."
          confirmLabel="حذف"
          pending={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {clearOpen && (
        <ConfirmDialog
          title="هل أنت متأكد من تصفية جميع المنتجات؟"
          description={`سيتم حذف جميع منتجات هذا المحل (${total} منتج). لا يمكن التراجع عن هذه العملية.`}
          confirmLabel="تصفية جميع المنتجات"
          pending={clearing}
          onCancel={() => setClearOpen(false)}
          onConfirm={() => void confirmClearAll()}
        />
      )}
    </div>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onCancel}>
      <div className="surface w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 font-bold">{title}</h2>
        <p className="mb-3 text-sm text-muted-foreground">{description}</p>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onCancel}>
            إلغاء
          </Button>
          <Button variant="destructive" className="flex-1" disabled={pending} onClick={onConfirm}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CategoriesDialog({
  storeId,
  categories,
  onClose,
  onChanged,
}: {
  storeId: string;
  categories: CategoryRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const { error } = await supabase.from("categories").insert({ store_id: storeId, name: trimmed });
    setCreating(false);
    if (error) return toast.error(error.message);
    setName("");
    toast.success("تزاد التصنيف.");
    onChanged();
  }

  async function rename(c: CategoryRow, next: string) {
    const trimmed = next.trim();
    if (!trimmed || trimmed === c.name) return;
    const { error } = await supabase.from("categories").update({ name: trimmed }).eq("id", c.id).eq("store_id", storeId);
    if (error) return toast.error(error.message.includes("uq_categories_store_name") ? "عندك تصنيف بنفس الاسم من قبل." : error.message);
    toast.success("تم التحديث.");
    onChanged();
  }

  async function toggle(c: CategoryRow) {
    const { error } = await supabase.from("categories").update({ is_active: !c.is_active }).eq("id", c.id).eq("store_id", storeId);
    if (error) return toast.error(error.message);
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="surface w-full max-w-lg p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 font-bold">تصنيفات المحل</h2>
        <div className="mb-4 flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مشروبات، ألبان، منظفات..." maxLength={60} />
          <Button disabled={!name.trim() || creating} onClick={() => void create()}>
            زيد
          </Button>
        </div>
        <ul className="max-h-72 space-y-2 overflow-y-auto">
          {categories.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-xl border border-border p-2">
              <Input defaultValue={c.name} className="flex-1" onBlur={(e) => void rename(c, e.target.value)} />
              <button
                type="button"
                onClick={() => void toggle(c)}
                className={`h-6 w-11 shrink-0 rounded-full transition-colors ${c.is_active ? "bg-[var(--primary)]" : "bg-[var(--muted)]"}`}
                aria-label="تفعيل التصنيف"
              >
                <span className={`block size-5 rounded-full bg-white shadow transition-transform ${c.is_active ? "translate-x-0.5" : "translate-x-5"}`} />
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">تعطيل تصنيف ما يحذفش منتجاته — تبقى موجودة وتقدر تبدّل تصنيفها.</p>
        <Button variant="outline" className="mt-3 w-full" onClick={onClose}>
          إغلاق
        </Button>
      </div>
    </div>
  );
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

function ProductFormDialog({
  storeId,
  product,
  categories,
  onClose,
  onSaved,
}: {
  storeId: string;
  product: ProductRow | null;
  categories: CategoryRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [barcode, setBarcode] = useState(product?.barcode ?? "");
  const [internalCode, setInternalCode] = useState(product?.internal_code ?? "");
  const [purchasePrice, setPurchasePrice] = useState(product?.purchase_price?.toString() ?? "");
  const [sellingPrice, setSellingPrice] = useState(product?.selling_price?.toString() ?? "");
  const [stockQuantity, setStockQuantity] = useState(product?.stock_quantity?.toString() ?? "0");
  const [lowStockThreshold, setLowStockThreshold] = useState(product?.low_stock_threshold?.toString() ?? "5");
  const [unit, setUnit] = useState(product?.unit ?? "وحدة");
  const [categoryId, setCategoryId] = useState(product?.category_id ?? "");
  const [expiryDate, setExpiryDate] = useState(product?.expiry_date ?? "");
  const [pointsReward, setPointsReward] = useState(product?.points_reward?.toString() ?? "0");
  const [isActive, setIsActive] = useState(product?.is_active ?? true);
  const [imageUrl, setImageUrl] = useState<string | null>(product?.image_url ?? null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [saving, setSaving] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

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
      description: description.trim() || null,
      barcode: trimmedBarcode,
      internal_code: internalCode.trim() || null,
      purchase_price: purchasePrice.trim() ? Number(purchasePrice) : null,
      selling_price: selling,
      stock_quantity: stockQuantity.trim() ? Number(stockQuantity) : 0,
      low_stock_threshold: lowStockThreshold.trim() ? Number(lowStockThreshold) : 5,
      unit,
      category_id: categoryId || null,
      image_url: imageUrl,
      points_reward: pointsReward.trim() ? Number(pointsReward) : 0,
      is_active: isActive,
      expiry_date: expiryDate.trim() || null,
    };

    setSaving(true);
    const { error } = product
      ? await supabase.from("products").update(payload).eq("id", product.id).eq("store_id", storeId)
      : await supabase.from("products").insert(payload);
    setSaving(false);
    if (error) return toast.error(mapProductError(error.message));
    toast.success(product ? "تم تحديث المنتج." : "تزاد المنتج بنجاح.");
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="surface my-8 w-full max-w-2xl p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 font-bold">{product ? "تعديل منتج" : "منتج جديد"}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="p-name">اسم المنتج *</Label>
            <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="p-desc">الوصف</Label>
            <textarea
              id="p-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={2}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div>
            <Label htmlFor="p-barcode">Barcode</Label>
            <Input id="p-barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} inputMode="numeric" placeholder="1234567890123" dir="ltr" />
            <p className="mt-1 text-xs text-muted-foreground">الباركود فريد داخل محلك فقط — محل آخر يقدر يستعمل نفس الرقم.</p>
          </div>

          <div>
            <Label htmlFor="p-code">الكود الداخلي</Label>
            <div className="flex gap-2">
              <Input id="p-code" value={internalCode} onChange={(e) => setInternalCode(e.target.value)} maxLength={40} dir="ltr" />
              <Button type="button" variant="outline" disabled={generatingCode} onClick={() => void generateCode()}>
                {generatingCode ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wand2 className="size-4" aria-hidden />}
              </Button>
            </div>
          </div>

          <div>
            <Label htmlFor="p-purchase">سعر الشراء (دج)</Label>
            <Input id="p-purchase" type="number" step="0.01" min="0" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">ما يظهرش للزبون.</p>
          </div>

          <div>
            <Label htmlFor="p-selling">سعر البيع (دج) *</Label>
            <Input id="p-selling" type="number" step="0.01" min="0" value={sellingPrice} onChange={(e) => setSellingPrice(e.target.value)} />
          </div>

          <div>
            <Label htmlFor="p-stock">الكمية</Label>
            <Input id="p-stock" type="number" step="0.01" value={stockQuantity} onChange={(e) => setStockQuantity(e.target.value)} />
          </div>

          <div>
            <Label htmlFor="p-low">حد المخزون الناقص</Label>
            <Input id="p-low" type="number" step="1" min="0" value={lowStockThreshold} onChange={(e) => setLowStockThreshold(e.target.value)} />
          </div>

          <div>
            <Label htmlFor="p-unit">الوحدة</Label>
            <select id="p-unit" value={unit} onChange={(e) => setUnit(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="p-cat">التصنيف</Label>
            <select id="p-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">بلا تصنيف</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <Label>صورة المنتج</Label>
            <div className="flex items-center gap-3">
              <div className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed border-border bg-muted">
                {imageUrl ? <img src={imageUrl} alt="" className="size-full object-cover" /> : <span className="text-[10px] text-muted-foreground">بلا صورة</span>}
              </div>
              <div className="flex flex-1 flex-col gap-2">
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
                {imageUrl && (
                  <button type="button" className="text-start text-xs text-destructive" onClick={() => setImageUrl(null)}>
                    احذف الصورة
                  </button>
                )}
              </div>
            </div>
          </div>

          <div>
            <Label htmlFor="p-expiry">تاريخ الصلاحية</Label>
            <Input id="p-expiry" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">اختياري — لمنتجات كالألبان والخبز.</p>
          </div>

          <div>
            <Label htmlFor="p-points">نقاط الوفاء</Label>
            <Input id="p-points" type="number" min="0" step="1" value={pointsReward} onChange={(e) => setPointsReward(e.target.value)} />
          </div>

          <div className="flex items-center gap-3 pt-6">
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

        <div className="mt-4 flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            إلغاء
          </Button>
          <Button className="flex-1" disabled={saving} onClick={() => void save()}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {product ? "حفظ التعديلات" : "زيد المنتج"}
          </Button>
        </div>
      </div>
    </div>
  );
}
