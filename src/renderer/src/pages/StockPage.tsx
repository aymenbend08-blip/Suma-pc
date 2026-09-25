import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarClock,
  ClipboardList,
  CloudOff,
  Download,
  History,
  Loader2,
  Minus,
  Plus,
  Search,
  XCircle,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { localDb } from "@/lib/localdb";
import { isNetworkError } from "@/lib/net";
import { uuid } from "@/lib/uuid";
import { adjustStock, applyStocktake, type AdjustStockArgs } from "@/lib/rpc";
import { useStore } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";
import { formatDA, formatDate, formatDateTime } from "@/lib/format";
import { findProductIdsByAltBarcode, sanitizeSearchTerm } from "@/lib/productBarcodes";
import type {
  CategoryRow,
  ProductRow,
  StockMovementRow,
  StocktakeLineRow,
  StocktakeSessionRow,
  StoreMemberRow,
} from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProductFichePage } from "@/pages/ProductFichePage";

const PAGE_SIZE = 20;

type Filter = "all" | "low_stock" | "out_of_stock" | "expiring_soon";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "الكل" },
  { key: "low_stock", label: "مخزون منخفض" },
  { key: "out_of_stock", label: "نفد المخزون" },
  { key: "expiring_soon", label: "قرب الانتهاء" },
];

const REASON_LABEL: Record<string, string> = {
  sale: "بيع",
  return: "إرجاع",
  purchase: "شراء",
  manual: "تعديل يدوي",
  stocktake: "جرد/تسوية",
};

function isExpiringSoon(expiryDate: string | null): "expired" | "soon" | null {
  if (!expiryDate) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (expiryDate < today) return "expired";
  const sevenAhead = new Date();
  sevenAhead.setDate(sevenAhead.getDate() + 7);
  if (expiryDate <= sevenAhead.toISOString().slice(0, 10)) return "soon";
  return null;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "الآن";
  if (minutes < 60) return `قبل ${minutes} د`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `قبل ${hours} س`;
  const days = Math.floor(hours / 24);
  return `قبل ${days} يوم`;
}

/**
 * A straight port of SUMA Web's المخزون screen (inventory.tsx) onto the
 * same RLS-scoped Supabase client every other Desktop screen uses —
 * same filters, same quick-adjust and stocktake sessions (apply_stocktake
 * RPC, logged in stocktake_sessions/stocktake_lines exactly like Web).
 *
 * Every stock-changing action here (quick +/-, single-item settlement,
 * full stocktake) goes through adjust_stock / apply_stocktake — both
 * SECURITY DEFINER RPCs that also write a stock_movements row internally
 * (see the stock_movements_ledger migration), so this screen never sends
 * an absolute `stock_quantity = X` write itself. The click-to-edit
 * absolute write this screen used to do was replaced by a single-item
 * stocktake (same apply_stocktake call the bulk "جرد سريع" mode uses,
 * just with one line) — same "I physically counted this" semantics, but
 * expressed as a delta computed server-side under a row lock, never a
 * raw overwrite a stale offline read could clobber.
 *
 * Offline behavior: the quick +/- buttons queue through the same local
 * SQLite outbox POS's offline sales use (operation_type "adjust_stock"),
 * so a cashier/owner correction made with no internet still applies
 * immediately to the on-screen number and replays automatically once
 * back online — never a lost update, since adjust_stock is a delta RPC
 * with FOR UPDATE row locking, the same reasoning that already protects
 * a phone sale and a Desktop sale of the same product at the same
 * instant. Everything that needs a fresh, authoritative read against the
 * whole catalog (full stocktake, movement history, the stocktake log,
 * CSV export) requires being online, same as Products/Fiche Produit.
 *
 * List rendered as a dense desktop table, not Web's stacked card list —
 * same standing rule established for the Products/Customers screens.
 */
export function StockPage() {
  const { active, perms } = useStore();
  const { isOnline, pendingCount, refreshPending } = useSync();
  const storeId = active!.id;

  const [rows, setRows] = useState<ProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<CategoryRow[]>([]);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [categoryId, setCategoryId] = useState("");
  const [page, setPage] = useState(0);

  const [busy, setBusy] = useState(false);

  const [stocktakeMode, setStocktakeMode] = useState(false);
  const [stocktakeEdits, setStocktakeEdits] = useState<Record<string, string>>({});
  const [savingStocktake, setSavingStocktake] = useState(false);

  const [logOpen, setLogOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [settleTarget, setSettleTarget] = useState<ProductRow | null>(null);
  const [historyTarget, setHistoryTarget] = useState<ProductRow | null>(null);
  const [ficheTarget, setFicheTarget] = useState<ProductRow | null>(null);
  const [lastMovementByProduct, setLastMovementByProduct] = useState<Record<string, StockMovementRow>>({});

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

    // A scanned/typed extra or variant barcode resolves to its product:
    // one capped id lookup across product_barcodes + product_variants,
    // OR'ed into the single list query (no per-row requests).
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
    if (categoryId) query = query.eq("category_id", categoryId);
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
    void loadLastMovements((data ?? []).map((r) => r.id));
  }

  /** One batched query for the "آخر حركة" hint under each visible row's
   * name, instead of one query per row — reduced client-side to the
   * single newest movement per product_id. */
  async function loadLastMovements(productIds: string[]) {
    if (productIds.length === 0) return setLastMovementByProduct({});
    const { data, error } = await supabase
      .from("stock_movements")
      .select("*")
      .in("product_id", productIds)
      .order("created_at", { ascending: false })
      .limit(productIds.length * 5);
    if (error) return;
    const byProduct: Record<string, StockMovementRow> = {};
    for (const m of data ?? []) {
      if (!m.product_id) continue;
      if (!byProduct[m.product_id]) byProduct[m.product_id] = m;
    }
    setLastMovementByProduct(byProduct);
  }

  useEffect(() => {
    void loadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    void loadProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, debouncedSearch, filter, categoryId, page]);

  function categoryName(id: string | null): string {
    return categories.find((c) => c.id === id)?.name ?? "بلا تصنيف";
  }

  // An atomic server-side delta (adjust_stock RPC, row-locked), not a
  // stale client read written back as an absolute value — a concurrent
  // POS sale (from this same computer or from the phone app) or a second
  // click can never be silently overwritten. If the request never
  // reaches Supabase at all (offline), the same delta is queued locally
  // and replayed later — exactly POS's own offline-sale fallback, just
  // for a manual stock correction instead of a sale.
  async function step(row: ProductRow, delta: number) {
    setBusy(true);
    const { error } = await adjustStock({ _product_id: row.id, _store_id: storeId, _delta: delta, _reason: "manual" });
    if (!error) {
      setBusy(false);
      void loadProducts();
      return;
    }
    if (!isNetworkError(error.message)) {
      setBusy(false);
      toast.error(error.message);
      return;
    }
    try {
      const args: AdjustStockArgs = {
        _product_id: row.id,
        _store_id: storeId,
        _delta: delta,
        _reason: "manual",
        _client_request_id: uuid(),
      };
      await localDb.enqueueOperation("adjust_stock", args);
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, stock_quantity: Math.max(0, Number(r.stock_quantity) + delta) } : r)),
      );
      toast.success("تم التعديل (بدون إنترنت) — سيُزامن تلقائيًا عند عودة الاتصال.");
      refreshPending();
    } catch (localError) {
      toast.error(localError instanceof Error ? localError.message : "تعذر حفظ التعديل حتى محليًا.");
    } finally {
      setBusy(false);
    }
  }

  const stocktakeChangedCount = Object.entries(stocktakeEdits).filter(([id, value]) => {
    const row = rows.find((r) => r.id === id);
    return row && value !== "" && Number.isFinite(Number(value)) && Number(value) !== Number(row.stock_quantity);
  }).length;

  async function saveStocktake() {
    const lines = Object.entries(stocktakeEdits)
      .filter(([id, value]) => {
        const row = rows.find((r) => r.id === id);
        return row && value !== "" && Number.isFinite(Number(value)) && Number(value) !== Number(row.stock_quantity);
      })
      .map(([productId, value]) => ({ product_id: productId, counted_quantity: Number(value) }));
    if (lines.length === 0) return;

    setSavingStocktake(true);
    const { data: session, error } = await applyStocktake({ _store_id: storeId, _lines: lines });
    setSavingStocktake(false);
    if (error) return toast.error(error.message);
    const s = session as StocktakeSessionRow;
    toast.success(`تحدّث الجرد — ${s.changed_count} منتج تغيّرت كميته من أصل ${s.line_count}`);
    setStocktakeEdits({});
    setStocktakeMode(false);
    void loadProducts();
  }

  async function exportCsv() {
    setExporting(true);
    const PAGE = 1000;
    const all: Array<{
      id: string;
      name: string;
      internal_code: string | null;
      barcode: string | null;
      purchase_price: number | null;
      selling_price: number | null;
      stock_quantity: number;
      category_id: string | null;
    }> = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("products")
        .select("id, name, internal_code, barcode, purchase_price, selling_price, stock_quantity, category_id")
        .eq("store_id", storeId)
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        setExporting(false);
        return toast.error(error.message);
      }
      all.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }

    const { data: aliasRows, error: aliasError } = await supabase
      .from("product_barcodes")
      .select("product_id, barcode")
      .eq("store_id", storeId);
    setExporting(false);
    if (aliasError) return toast.error(aliasError.message);
    const aliasesByProduct = new Map<string, string[]>();
    for (const a of aliasRows ?? []) {
      const list = aliasesByProduct.get(a.product_id) ?? [];
      list.push(a.barcode);
      aliasesByProduct.set(a.product_id, list);
    }

    const headers = ["الاسم", "الكود الداخلي", "التصنيف", "سعر الشراء", "سعر البيع", "الكمية", "الباركود", "باركودات إضافية"];
    const csvEscape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [headers.map(csvEscape).join(",")];
    for (const p of all) {
      lines.push(
        [
          p.name,
          p.internal_code ?? "",
          categoryName(p.category_id),
          p.purchase_price ?? "",
          p.selling_price ?? "",
          String(p.stock_quantity),
          p.barcode ?? "",
          (aliasesByProduct.get(p.id) ?? []).join(" / "),
        ]
          .map((v) => csvEscape(String(v)))
          .join(","),
      );
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `suma-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`تم تصدير ${all.length} منتج.`);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">المخزون</h1>
          <p className="text-xs text-muted-foreground num">{total} منتج في محلك</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={!isOnline} title={!isOnline ? "يحتاج اتصالاً بالإنترنت" : undefined} onClick={() => setLogOpen(true)}>
            <History className="size-4" aria-hidden />
            سجل الجرد
          </Button>
          <Button
            variant={stocktakeMode ? "default" : "outline"}
            disabled={!isOnline}
            title={!isOnline ? "يحتاج اتصالاً بالإنترنت" : undefined}
            onClick={() => {
              setStocktakeMode((v) => !v);
              setStocktakeEdits({});
            }}
          >
            <ClipboardList className="size-4" aria-hidden />
            {stocktakeMode ? "إلغاء الجرد" : "جرد سريع"}
          </Button>
        </div>
      </div>

      {!isOnline && (
        <div className="surface flex items-center gap-2 border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-xs">
          <CloudOff className="size-4 shrink-0 text-[var(--warning-foreground)]" aria-hidden />
          <p>
            غير متصل — أزرار +/- تعمل وتُحفظ محليًا وتُزامَن تلقائيًا عند عودة الاتصال. الجرد الكامل، التسوية اليدوية،
            سجل الجرد، والتصدير تحتاج اتصالاً بالإنترنت.
            {pendingCount > 0 && ` (${pendingCount} عملية بانتظار المزامنة)`}
          </p>
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
        <div className="flex gap-2 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                setFilter(f.key);
                setPage(0);
              }}
              className={
                filter === f.key
                  ? "shrink-0 rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-bold text-[var(--primary-foreground)]"
                  : "shrink-0 rounded-full bg-[var(--muted)] px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-[var(--accent)]/20"
              }
            >
              {f.label}
            </button>
          ))}
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
        <Button variant="outline" disabled={exporting || !isOnline} title={!isOnline ? "يحتاج اتصالاً بالإنترنت" : undefined} onClick={() => void exportCsv()}>
          {exporting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
          {exporting ? "جاري التصدير..." : "تصدير"}
        </Button>
      </div>

      {stocktakeMode && (
        <div className="surface flex flex-wrap items-center justify-between gap-3 p-3">
          <p className="text-xs text-muted-foreground">
            الجرد يشمل المنتجات المعروضة في هذه الصفحة فقط — بدّل الصفحة أو الفلتر باش تكمّل الباقي.
          </p>
          <Button size="sm" disabled={stocktakeChangedCount === 0 || savingStocktake} onClick={() => void saveStocktake()}>
            {savingStocktake && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {savingStocktake ? "جاري الحفظ..." : `حفظ الجرد${stocktakeChangedCount > 0 ? ` (${stocktakeChangedCount})` : ""}`}
          </Button>
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">جاري التحميل...</p>
      ) : rows.length === 0 ? (
        <div className="surface py-8 text-center text-sm text-muted-foreground">ما كانش منتجات تطابق هذا الفلتر</div>
      ) : (
        <>
          <div className="surface overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
                  <th className="px-3 py-2 text-start font-bold">المنتج</th>
                  <th className="px-3 py-2 text-start font-bold">الباركود / الكود</th>
                  <th className="px-3 py-2 text-start font-bold">التصنيف</th>
                  <th className="w-24 px-3 py-2 text-end font-bold">السعر</th>
                  <th className="px-3 py-2 text-start font-bold">تاريخ الانتهاء</th>
                  <th className="w-40 px-3 py-2 text-center font-bold">الحالة</th>
                  <th className="w-40 px-3 py-2 text-center font-bold">الكمية</th>
                  <th className="w-16 px-3 py-2 text-center font-bold">سجل</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const stock = Number(row.stock_quantity);
                  const low = row.is_low_stock;
                  const out = stock <= 0;
                  const expiry = isExpiringSoon(row.expiry_date);
                  const lastMovement = lastMovementByProduct[row.id];
                  return (
                    <tr key={row.id} className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"}`}>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="flex items-center gap-2 text-start hover:underline"
                          title="فتح بطاقة المنتج"
                          onClick={() => setFicheTarget(row)}
                        >
                          {row.image_url ? (
                            <img src={row.image_url} alt="" className="size-9 shrink-0 rounded-md object-cover" />
                          ) : (
                            <div className="size-9 shrink-0 rounded-md bg-[var(--muted)]" />
                          )}
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{row.name}</span>
                            {lastMovement && (
                              <span className="block text-[10px] text-muted-foreground">
                                آخر حركة: {REASON_LABEL[lastMovement.reason] ?? lastMovement.reason} · {relativeTime(lastMovement.created_at)}
                              </span>
                            )}
                          </span>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground num" dir="ltr">
                        {[row.barcode, row.internal_code].filter(Boolean).join(" · ") || "—"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{categoryName(row.category_id)}</td>
                      <td className="px-3 py-2 text-end text-xs font-semibold num">{formatDA(row.selling_price)}</td>
                      <td className="px-3 py-2 text-xs">
                        {row.expiry_date ? (
                          <span className={`flex items-center gap-1 ${expiry === "expired" ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                            <CalendarClock className="size-3" aria-hidden />
                            {expiry === "expired" ? "انتهى: " : "ينتهي: "}
                            {formatDate(row.expiry_date)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-center gap-1">
                          {out ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--destructive)] px-2 py-0.5 text-[11px] font-bold text-white">
                              <XCircle className="size-3" aria-hidden /> نفد
                            </span>
                          ) : low ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--warning)] px-2 py-0.5 text-[11px] font-bold text-[var(--warning-foreground)]">
                              <AlertTriangle className="size-3" aria-hidden /> منخفض
                            </span>
                          ) : (
                            <span className="rounded-full bg-[var(--primary)]/10 px-2 py-0.5 text-[11px] font-semibold text-[var(--primary)]">متوفر</span>
                          )}
                          {expiry && (
                            <span
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                                expiry === "expired" ? "bg-[var(--destructive)]/10 text-destructive" : "bg-[var(--warning)]/20 text-[var(--warning-foreground)]"
                              }`}
                            >
                              <CalendarClock className="size-3" aria-hidden />
                              {expiry === "expired" ? "منتهي" : "قرب الانتهاء"}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-center gap-2">
                          {stocktakeMode ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <Input
                                type="number"
                                value={stocktakeEdits[row.id] ?? String(stock)}
                                onChange={(e) => setStocktakeEdits((prev) => ({ ...prev, [row.id]: e.target.value }))}
                                className="h-8 w-20 text-center"
                              />
                              {(() => {
                                const editVal = stocktakeEdits[row.id];
                                if (editVal === undefined || editVal === "" || !Number.isFinite(Number(editVal))) return null;
                                const diff = Number(editVal) - stock;
                                if (diff === 0) return null;
                                return (
                                  <span className={`text-[10px] font-bold num ${diff > 0 ? "text-[var(--primary)]" : "text-destructive"}`}>
                                    {diff > 0 ? "+" : ""}
                                    {diff}
                                  </span>
                                );
                              })()}
                            </div>
                          ) : (
                            <>
                              <Button
                                variant="outline"
                                size="icon"
                                className="size-7"
                                disabled={busy}
                                onClick={() => void step(row, -1)}
                                aria-label="إنقاص"
                              >
                                <Minus className="size-3" aria-hidden />
                              </Button>
                              <div className="flex flex-col items-center">
                                <button
                                  type="button"
                                  onClick={() => setSettleTarget(row)}
                                  disabled={!isOnline}
                                  title={isOnline ? "تسوية الكمية الفعلية" : "تسوية الكمية تحتاج اتصالاً بالإنترنت"}
                                  className="w-12 text-center text-sm font-bold num disabled:cursor-not-allowed"
                                >
                                  {stock} {row.unit}
                                </button>
                                {row.low_stock_threshold != null && (
                                  <span className="text-[10px] text-muted-foreground num">الحد: {row.low_stock_threshold}</span>
                                )}
                              </div>
                              <Button
                                variant="outline"
                                size="icon"
                                className="size-7"
                                disabled={busy}
                                onClick={() => void step(row, 1)}
                                aria-label="زيادة"
                              >
                                <Plus className="size-3" aria-hidden />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-7"
                          disabled={!isOnline}
                          title={isOnline ? "حركة هذا المنتج" : "يحتاج اتصالاً بالإنترنت"}
                          onClick={() => setHistoryTarget(row)}
                        >
                          <History className="size-3.5" aria-hidden />
                        </Button>
                      </td>
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

      {!perms.isAdmin && (
        <p className="text-xs text-muted-foreground">صلاحية إدارة المنتجات تسمح لك بتصحيح المخزون والجرد في هذا المحل.</p>
      )}

      {logOpen && <StocktakeLogDialog storeId={storeId} onClose={() => setLogOpen(false)} />}

      {settleTarget && (
        <SettleModal
          product={settleTarget}
          storeId={storeId}
          onClose={() => setSettleTarget(null)}
          onSaved={() => {
            setSettleTarget(null);
            void loadProducts();
          }}
        />
      )}

      {historyTarget && <MovementHistoryDialog product={historyTarget} storeId={storeId} onClose={() => setHistoryTarget(null)} />}

      {ficheTarget && (
        <ProductFichePage
          storeId={storeId}
          product={ficheTarget}
          categories={categories}
          onClose={() => setFicheTarget(null)}
          onSaved={(saved) => {
            setFicheTarget(null);
            // Patch in place when no filter could have changed the row's
            // membership on this page; otherwise re-run the list query.
            if (filter === "all" && !categoryId) setRows((prev) => prev.map((r) => (r.id === saved.id ? saved : r)));
            else void loadProducts();
          }}
        />
      )}
    </div>
  );
}

/**
 * Single-item stocktake — replaces the old "type an absolute number,
 * write stock_quantity = X directly" edit. Goes through the exact same
 * apply_stocktake RPC the bulk "جرد سريع" mode uses (one line instead of
 * many): the server computes the delta itself under a row lock and logs
 * it as a real stocktake movement, so a manual correction can never
 * silently overwrite a sale that landed between the read and the write.
 */
function SettleModal({
  product,
  storeId,
  onClose,
  onSaved,
}: {
  product: ProductRow;
  storeId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(String(product.stock_quantity));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    const counted = Number(value);
    if (!Number.isFinite(counted) || counted < 0) return toast.error("كمية غير صالحة.");
    setSaving(true);
    const { data, error } = await applyStocktake({
      _store_id: storeId,
      _lines: [{ product_id: product.id, counted_quantity: counted }],
      _notes: note.trim() || undefined,
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    const changed = (data as StocktakeSessionRow | null)?.changed_count ?? 0;
    toast.success(changed > 0 ? `تم تصحيح الكمية إلى ${counted}.` : "الكمية المدخلة نفس الكمية الحالية — لا تغيير.");
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="surface w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 font-bold">تسوية كمية: {product.name}</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          الكمية المسجّلة حاليًا: <span className="num font-semibold">{product.stock_quantity}</span> {product.unit}. اكتب الكمية
          الفعلية بعد العدّ اليدوي.
        </p>
        <div className="space-y-3">
          <div>
            <Label htmlFor="counted">الكمية الفعلية</Label>
            <Input id="counted" type="number" min="0" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </div>
          {Number.isFinite(Number(value)) && Number(value) !== product.stock_quantity && (
            <div className="rounded-lg bg-[var(--muted)] p-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">المتوقع (المسجَّل حاليًا)</span>
                <span className="num font-semibold">{product.stock_quantity}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">المعدود (المُدخَل)</span>
                <span className="num font-semibold">{Number(value)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between border-t border-border pt-1">
                <span className="font-semibold">الفرق</span>
                <span className={`num font-bold ${Number(value) > product.stock_quantity ? "text-[var(--primary)]" : "text-destructive"}`}>
                  {Number(value) > product.stock_quantity ? "+" : ""}
                  {Number(value) - product.stock_quantity}
                </span>
              </div>
            </div>
          )}
          <div>
            <Label htmlFor="settle-note">ملاحظة (اختياري)</Label>
            <Input id="settle-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="سبب الفرق مثلاً" maxLength={200} />
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            إلغاء
          </Button>
          <Button className="flex-1" disabled={saving} onClick={() => void save()}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            حفظ
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Full "why did this change" trail for one product — every sale,
 * return, purchase receipt, manual adjustment, and stocktake line that
 * ever touched its stock_quantity, newest first. */
function MovementHistoryDialog({ product, storeId, onClose }: { product: ProductRow; storeId: string; onClose: () => void }) {
  const [movements, setMovements] = useState<StockMovementRow[] | null>(null);
  const [members, setMembers] = useState<StoreMemberRow[]>([]);

  useEffect(() => {
    void (async () => {
      const [movementsRes, membersRes] = await Promise.all([
        supabase
          .from("stock_movements")
          .select("*")
          .eq("store_id", storeId)
          .eq("product_id", product.id)
          .order("created_at", { ascending: false })
          .limit(50),
        supabase.from("store_members").select("*").eq("store_id", storeId),
      ]);
      if (movementsRes.error) return toast.error(movementsRes.error.message);
      setMovements(movementsRes.data ?? []);
      setMembers(membersRes.data ?? []);
    })();
  }, [storeId, product.id]);

  function userName(id: string | null): string {
    if (!id) return "النظام";
    return members.find((m) => m.user_id === id)?.full_name ?? "مستخدم";
  }

  function referenceLabel(referenceType: string | null): string | null {
    if (!referenceType) return null;
    const labels: Record<string, string> = { sale: "عملية بيع", purchase_order: "أمر شراء", stocktake_session: "جلسة جرد" };
    return labels[referenceType] ?? referenceType;
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="surface flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-border p-4">
          <h2 className="font-bold">حركة المخزون — {product.name}</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {movements === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">جاري التحميل...</p>
          ) : movements.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">ما كانش أي حركة مسجّلة لهذا المنتج بعد.</p>
          ) : (
            <ul className="grid gap-2">
              {movements.map((m) => (
                <li key={m.id} className="rounded-xl border border-border p-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded-full bg-[var(--muted)] px-2 py-0.5 font-semibold">{REASON_LABEL[m.reason] ?? m.reason}</span>
                    <span className="text-muted-foreground">{formatDateTime(m.created_at)}</span>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="num">
                      {m.quantity_before} ← {m.quantity_after} ({Number(m.delta) > 0 ? "+" : ""}
                      {m.delta})
                    </span>
                    <span className="text-muted-foreground">{userName(m.created_by)}</span>
                  </div>
                  {referenceLabel(m.reference_type) && (
                    <p className="mt-1 text-muted-foreground">المرجع: {referenceLabel(m.reference_type)}</p>
                  )}
                  {m.notes && <p className="mt-1 text-muted-foreground">{m.notes}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-border p-4">
          <Button variant="outline" className="w-full" onClick={onClose}>
            إغلاق
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Past stocktake sessions — click one to see exactly what was counted. */
function StocktakeLogDialog({ storeId, onClose }: { storeId: string; onClose: () => void }) {
  const [sessions, setSessions] = useState<StocktakeSessionRow[] | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [lines, setLines] = useState<StocktakeLineRow[] | null>(null);
  const [linesLoading, setLinesLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data, error } = await supabase
        .from("stocktake_sessions")
        .select("*")
        .eq("store_id", storeId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return toast.error(error.message);
      setSessions(data ?? []);
    })();
  }, [storeId]);

  async function toggleSession(id: string) {
    if (openSessionId === id) {
      setOpenSessionId(null);
      return;
    }
    setOpenSessionId(id);
    setLinesLoading(true);
    const { data, error } = await supabase
      .from("stocktake_lines")
      .select("*")
      .eq("session_id", id)
      .order("product_name");
    setLinesLoading(false);
    if (error) return toast.error(error.message);
    setLines(data ?? []);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="surface flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-border p-4">
          <h2 className="font-bold">سجل الجرد</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {sessions === null ? (
            <p className="py-6 text-center text-sm text-muted-foreground">جاري التحميل...</p>
          ) : sessions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">ما كانش عمليات جرد مسجّلة بعد.</p>
          ) : (
            <div className="grid gap-2">
              {sessions.map((s) => {
                const isOpen = openSessionId === s.id;
                return (
                  <div key={s.id} className="surface p-3">
                    <button type="button" className="flex w-full items-center justify-between gap-2 text-start text-sm" onClick={() => void toggleSession(s.id)}>
                      <span>
                        <span className="font-semibold">{formatDateTime(s.created_at)}</span>
                        {s.notes && <span className="text-muted-foreground"> — {s.notes}</span>}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground num">
                        {s.changed_count} تغيّر من {s.line_count}
                      </span>
                    </button>
                    {isOpen && (
                      <ul className="mt-2 grid gap-1 border-t border-border pt-2">
                        {linesLoading ? (
                          <li className="py-2 text-center text-xs text-muted-foreground">جاري التحميل...</li>
                        ) : (
                          (lines ?? [])
                            .filter((l) => Number(l.delta) !== 0)
                            .map((l) => (
                              <li key={l.id} className="flex items-center justify-between text-xs">
                                <span className="min-w-0 truncate">{l.product_name}</span>
                                <span className="shrink-0 text-muted-foreground num">
                                  {l.previous_quantity} ← {l.counted_quantity} ({Number(l.delta) > 0 ? "+" : ""}
                                  {l.delta})
                                </span>
                              </li>
                            ))
                        )}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="border-t border-border p-4">
          <Button variant="outline" className="w-full" onClick={onClose}>
            إغلاق
          </Button>
        </div>
      </div>
    </div>
  );
}
