import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CloudOff, FileDown, FileUp, FolderPlus, Loader2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useStore } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";
import { formatDA } from "@/lib/format";
import { findProductIdsByAltBarcode, mapProductError, sanitizeSearchTerm } from "@/lib/productBarcodes";
import { EXPORT_HEADERS, buildExportRow, chunk } from "@/lib/productImport";
import type { CategoryRow, ProductRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/products/ConfirmDialog";
import { ProductImportDialog } from "@/components/products/ProductImportDialog";
import { ProductFichePage } from "@/pages/ProductFichePage";

const PAGE_SIZE = 20;
const BARCODE_LIKE = /^[0-9]{6,}$/;
const EXPORT_PAGE = 1000;
/** ids per `.in()` batch — keeps the request URL well under proxy limits. */
const IN_BATCH = 200;

type FilterKind = "all" | "active" | "inactive" | "low_stock" | "out_of_stock" | "expiring_soon";

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
 * Also intentionally deferred: the camera barcode scanner (a USB/
 * keyboard-wedge scanner typing into the barcode field already works,
 * which is the normal Desktop setup anyway). Excel import/export live here
 * (ProductImportDialog / exportExcel); price history is on Fiche Produit.
 *
 * Add/edit now opens ProductFichePage — a full-screen "Fiche Produit"
 * view, not the small dialog this started as (see that file). It also
 * opens when a barcode search here matches nothing, with the scanned
 * code prefilled, so scanning an unknown item is itself the "add it"
 * flow.
 */
export function ProductsPage() {
  const { active, perms } = useStore();
  const { isOnline } = useSync();
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
  const [pendingBarcode, setPendingBarcode] = useState<string | undefined>(undefined);
  const [catOpen, setCatOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProductRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

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
    const term = sanitizeSearchTerm(debouncedSearch);

    // Two-step search (SUMA Web's pattern): product ids whose EXTRA or
    // VARIANT barcode matches, capped, then OR'ed into the one list query
    // as id.in.(...) — never a query per row.
    const aliasIds = term ? await findProductIdsByAltBarcode(storeId, term) : [];

    let query = supabase
      .from("products")
      .select("*", { count: "exact" })
      .eq("store_id", storeId)
      .range(from, from + PAGE_SIZE - 1);

    if (term) {
      const orParts = [`name.ilike.%${term}%`, `barcode.ilike.%${term}%`, `internal_code.ilike.%${term}%`];
      if (aliasIds.length > 0) orParts.push(`id.in.(${aliasIds.join(",")})`);
      query = query.or(orParts.join(","));
    }
    if (priceMin.trim() && Number.isFinite(Number(priceMin))) query = query.gte("selling_price", Number(priceMin));
    if (priceMax.trim() && Number.isFinite(Number(priceMax))) query = query.lte("selling_price", Number(priceMax));
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
    if (!isOnline) return toast.error("تعديل المنتج يحتاج اتصالاً بالإنترنت.");
    const { data, error } = await supabase
      .from("products")
      .update({ is_active: !row.is_active })
      .eq("id", row.id)
      .eq("store_id", storeId)
      .select()
      .single();
    if (error) return toast.error(mapProductError(error));
    toast.success("تم تحديث حالة المنتج.");
    // Patch the one row in place — unless the active/inactive filter means
    // it no longer belongs on this page.
    if (filter === "active" || filter === "inactive") void loadProducts();
    else setRows((prev) => prev.map((r) => (r.id === row.id ? (data as ProductRow) : r)));
  }

  /** SUMA Web's export columns (so the file re-imports cleanly) + unit.
   * Products in 1000-row pages; extra barcodes batch-loaded per page with
   * `.in()` — no request per product. */
  async function exportExcel() {
    if (!isOnline) return toast.error("التصدير يحتاج اتصالاً بالإنترنت.");
    setExporting(true);
    try {
      const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
      const out: ReturnType<typeof buildExportRow>[] = [];
      for (let from = 0; ; from += EXPORT_PAGE) {
        const { data, error } = await supabase
          .from("products")
          .select("id, name, internal_code, category_id, purchase_price, selling_price, stock_quantity, barcode, unit")
          .eq("store_id", storeId)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + EXPORT_PAGE - 1);
        if (error) throw new Error(error.message);
        const pageRows = data ?? [];
        const extras = new Map<string, string[]>();
        for (const ids of chunk(pageRows.map((p) => p.id), IN_BATCH)) {
          for (let bFrom = 0; ; bFrom += EXPORT_PAGE) {
            const { data: barcodes, error: bError } = await supabase
              .from("product_barcodes")
              .select("product_id, barcode")
              .eq("store_id", storeId)
              .in("product_id", ids)
              .order("created_at", { ascending: true })
              .order("id", { ascending: true })
              .range(bFrom, bFrom + EXPORT_PAGE - 1);
            if (bError) throw new Error(bError.message);
            for (const b of barcodes ?? []) extras.set(b.product_id, [...(extras.get(b.product_id) ?? []), b.barcode]);
            if (!barcodes || barcodes.length < EXPORT_PAGE) break;
          }
        }
        for (const p of pageRows) out.push(buildExportRow(p, categoryNames, extras));
        if (pageRows.length < EXPORT_PAGE) break;
      }
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.json_to_sheet(out, { header: [...EXPORT_HEADERS] });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "منتجات");
      XLSX.writeFile(wb, `SUMA-products-${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success(`تم تصدير ${out.length} منتج.`);
    } catch (error) {
      toast.error(`تعذّر التصدير: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase.from("products").delete().eq("id", deleteTarget.id).eq("store_id", storeId);
    setDeleting(false);
    if (error) return toast.error(mapProductError(error));
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
        <div className="flex flex-wrap items-center gap-2">
          {perms.canManageProducts && (
            <>
              <Button
                variant="outline"
                disabled={!isOnline}
                title={!isOnline ? "يحتاج اتصالاً بالإنترنت" : undefined}
                onClick={() => setImportOpen(true)}
              >
                <FileUp className="size-4" aria-hidden />
                استيراد Excel
              </Button>
              <Button
                variant="outline"
                disabled={exporting || !isOnline}
                title={!isOnline ? "يحتاج اتصالاً بالإنترنت" : undefined}
                onClick={() => void exportExcel()}
              >
                {exporting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FileDown className="size-4" aria-hidden />}
                {exporting ? "جاري التصدير..." : "تصدير Excel"}
              </Button>
            </>
          )}
          {/* Creating a product is store-admin only (RLS products_admin_insert). */}
          {perms.isAdmin && (
            <Button
              disabled={!isOnline}
              title={!isOnline ? "يحتاج اتصالاً بالإنترنت" : undefined}
              onClick={() => {
                setEditing(null);
                setPendingBarcode(undefined);
                setFormOpen(true);
              }}
            >
              <Plus className="size-4" aria-hidden />
              منتج جديد
            </Button>
          )}
        </div>
      </div>

      {!isOnline && (
        <div className="surface flex items-center gap-2 border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-xs">
          <CloudOff className="size-4 shrink-0 text-[var(--warning-foreground)]" aria-hidden />
          <p>غير متصل — إضافة المنتجات وتعديلها والاستيراد والتصدير تحتاج اتصالاً بالإنترنت.</p>
        </div>
      )}

      <div className="surface flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-48 flex-1">
          <Label htmlFor="q">البحث بالاسم / الباركود (أساسي، إضافي، تنويعة) / الكود الداخلي</Label>
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
            <option value="inactive">غير مفعّل</option>
            <option value="low_stock">مخزون ناقص</option>
            <option value="out_of_stock">نفد</option>
            <option value="expiring_soon">قرب انتهاء الصلاحية</option>
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
        <div className="surface space-y-2 py-8 text-center text-sm text-muted-foreground">
          <p>ما كانش منتجات</p>
          {BARCODE_LIKE.test(debouncedSearch) && perms.isAdmin && isOnline && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(null);
                setPendingBarcode(debouncedSearch);
                setFormOpen(true);
              }}
            >
              <Plus className="size-4" aria-hidden />
              إضافة منتج جديد بهذا الباركود ({debouncedSearch})
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* A dense table, not a stacked card list — desktop has the width
              to show every column at once, so it should, rather than
              reusing the phone-width layout SUMA Web's own list uses. */}
          <div className="surface overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
                  <th className="px-3 py-2 text-start font-bold">المنتج</th>
                  <th className="px-3 py-2 text-start font-bold">الباركود / الكود</th>
                  <th className="px-3 py-2 text-start font-bold">التصنيف</th>
                  <th className="w-28 px-3 py-2 text-end font-bold">السعر</th>
                  <th className="w-40 px-3 py-2 text-center font-bold">المخزون</th>
                  {perms.canManageProducts && <th className="w-24 px-3 py-2 text-center font-bold">مفعّل</th>}
                  {perms.canManageProducts && <th className="w-24 px-3 py-2 text-center font-bold">إجراءات</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const stock = Number(row.stock_quantity);
                  const low = Number(row.low_stock_threshold);
                  return (
                    <tr key={row.id} className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"}`}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {row.image_url ? (
                            <img src={row.image_url} alt="" className="size-9 shrink-0 rounded-md object-cover" />
                          ) : (
                            <div className="size-9 shrink-0 rounded-md bg-[var(--muted)]" />
                          )}
                          <span className="truncate font-medium">{row.name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground num" dir="ltr">
                        {[row.barcode, row.internal_code].filter(Boolean).join(" · ") || "—"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{categoryName(row.category_id)}</td>
                      <td className="px-3 py-2 text-end font-bold num">{formatDA(row.selling_price)}</td>
                      <td className="px-3 py-2 text-center">
                        {stock <= 0 ? (
                          <span className="rounded-full bg-[var(--destructive)] px-2 py-0.5 text-[11px] font-bold text-white">كمل</span>
                        ) : stock <= low ? (
                          <span className="rounded-full bg-[var(--warning)] px-2 py-0.5 text-[11px] font-bold text-[var(--warning-foreground)] num">
                            ناقص ({stock})
                          </span>
                        ) : (
                          <span className="text-xs num">
                            {stock} {row.unit}
                          </span>
                        )}
                      </td>
                      {perms.canManageProducts && (
                        <td className="px-3 py-2 text-center">
                          <button
                            type="button"
                            disabled={!isOnline}
                            onClick={() => void toggleActive(row)}
                            className={`h-6 w-11 rounded-full transition-colors ${row.is_active ? "bg-[var(--primary)]" : "bg-[var(--muted)]"}`}
                            aria-label="تفعيل / تعطيل"
                          >
                            <span
                              className={`block size-5 rounded-full bg-white shadow transition-transform ${row.is_active ? "translate-x-0.5" : "translate-x-5"}`}
                            />
                          </button>
                        </td>
                      )}
                      {perms.canManageProducts && (
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-center gap-1.5">
                            <Button
                              size="icon"
                              variant="outline"
                              className="size-7"
                              aria-label="تعديل"
                              onClick={() => {
                                setEditing(row);
                                setPendingBarcode(undefined);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </Button>
                            {/* Deleting is store-admin only (RLS). */}
                            {perms.isAdmin && (
                              <Button size="icon" variant="outline" className="size-7" aria-label="حذف" disabled={!isOnline} onClick={() => setDeleteTarget(row)}>
                                <Trash2 className="size-3.5 text-destructive" aria-hidden />
                              </Button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

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
        <ProductFichePage
          storeId={storeId}
          product={editing}
          categories={categories}
          initialBarcode={pendingBarcode}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
            setPendingBarcode(undefined);
          }}
          onSaved={(saved) => {
            const wasEdit = Boolean(editing);
            setFormOpen(false);
            setEditing(null);
            setPendingBarcode(undefined);
            // An edit patches its row in place; a new product needs the
            // list query (ordering, filters, count) to place it.
            if (wasEdit) setRows((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
            else void loadProducts();
          }}
        />
      )}

      {importOpen && (
        <ProductImportDialog
          storeId={storeId}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            void loadProducts();
            void loadCategories();
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

