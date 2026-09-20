import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarClock,
  ClipboardList,
  Download,
  History,
  Loader2,
  Minus,
  Plus,
  Search,
  XCircle,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useStore } from "@/context/StoreContext";
import { formatDate, formatDateTime } from "@/lib/format";
import type { CategoryRow, ProductRow, StocktakeLineRow, StocktakeSessionRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PAGE_SIZE = 20;

type Filter = "all" | "low_stock" | "out_of_stock" | "expiring_soon";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "الكل" },
  { key: "low_stock", label: "مخزون منخفض" },
  { key: "out_of_stock", label: "نفد المخزون" },
  { key: "expiring_soon", label: "قرب الانتهاء" },
];

/**
 * A straight port of SUMA Web's المخزون screen (inventory.tsx) onto the
 * same RLS-scoped Supabase client every other Desktop screen uses —
 * same filters, same +/- quick-adjust and click-to-edit quantity, same
 * formal stocktake sessions (apply_stocktake RPC, logged in
 * stocktake_sessions/stocktake_lines exactly like Web). adjust_stock and
 * apply_stocktake are both already GRANT EXECUTE'd to `authenticated` and
 * apply_stocktake writes its own audit_logs row internally — unlike the
 * Products screen, there's no service-role-only side effect skipped here.
 *
 * Two things deferred, same reasoning as the Products screen: the camera
 * barcode scanner (a keyboard-wedge USB scanner typing into the search
 * field already works) and Web's .xlsx export (done here as CSV instead,
 * so no new dependency is needed — same columns, opens fine in Excel).
 *
 * List rendered as a dense desktop table, not Web's stacked card list —
 * same standing rule established for the Products/Customers screens.
 */
export function StockPage() {
  const { active, perms } = useStore();
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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [busy, setBusy] = useState(false);

  const [stocktakeMode, setStocktakeMode] = useState(false);
  const [stocktakeEdits, setStocktakeEdits] = useState<Record<string, string>>({});
  const [savingStocktake, setSavingStocktake] = useState(false);

  const [logOpen, setLogOpen] = useState(false);
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

  // An atomic server-side delta (adjust_stock RPC), not a stale client
  // read written back as an absolute value — a concurrent POS sale or a
  // second click can't get silently overwritten.
  async function step(id: string, delta: number) {
    setBusy(true);
    const { error } = await supabase.rpc("adjust_stock", { _product_id: id, _store_id: storeId, _delta: delta });
    setBusy(false);
    if (error) return toast.error(error.message);
    void loadProducts();
  }

  function startEdit(id: string, current: number) {
    setEditingId(id);
    setEditValue(String(current));
  }

  async function saveEdit(id: string) {
    setBusy(true);
    const { error } = await supabase
      .from("products")
      .update({ stock_quantity: Number(editValue) || 0 })
      .eq("id", id)
      .eq("store_id", storeId);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("تحدّث المخزون.");
    setEditingId(null);
    void loadProducts();
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
    const { data: session, error } = await supabase.rpc("apply_stocktake", { _store_id: storeId, _lines: lines });
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
          <Button variant="outline" onClick={() => setLogOpen(true)}>
            <History className="size-4" aria-hidden />
            سجل الجرد
          </Button>
          <Button
            variant={stocktakeMode ? "default" : "outline"}
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

      <div className="surface flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-48 flex-1">
          <Label htmlFor="q">البحث بالاسم / الباركود / الكود الداخلي</Label>
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
        <Button variant="outline" disabled={exporting} onClick={() => void exportCsv()}>
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
                  <th className="px-3 py-2 text-start font-bold">تاريخ الانتهاء</th>
                  <th className="w-28 px-3 py-2 text-center font-bold">الحالة</th>
                  <th className="w-40 px-3 py-2 text-center font-bold">الكمية</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const stock = Number(row.stock_quantity);
                  const low = row.is_low_stock;
                  const out = stock <= 0;
                  const expired = row.expiry_date ? row.expiry_date < new Date().toISOString().slice(0, 10) : false;
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
                      <td className="px-3 py-2 text-xs">
                        {row.expiry_date ? (
                          <span className={`flex items-center gap-1 ${expired ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                            <CalendarClock className="size-3" aria-hidden />
                            {expired ? "انتهى: " : "ينتهي: "}
                            {formatDate(row.expiry_date)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
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
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-center gap-2">
                          {stocktakeMode ? (
                            <Input
                              type="number"
                              value={stocktakeEdits[row.id] ?? String(stock)}
                              onChange={(e) => setStocktakeEdits((prev) => ({ ...prev, [row.id]: e.target.value }))}
                              className="h-8 w-20 text-center"
                            />
                          ) : editingId === row.id ? (
                            <>
                              <Input
                                type="number"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                className="h-8 w-20 text-center"
                                autoFocus
                              />
                              <Button size="sm" disabled={busy} onClick={() => void saveEdit(row.id)}>
                                حفظ
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                variant="outline"
                                size="icon"
                                className="size-7"
                                disabled={busy}
                                onClick={() => void step(row.id, -1)}
                                aria-label="إنقاص"
                              >
                                <Minus className="size-3" aria-hidden />
                              </Button>
                              <button
                                type="button"
                                onClick={() => startEdit(row.id, stock)}
                                className="w-12 text-center text-sm font-bold num"
                              >
                                {stock} {row.unit}
                              </button>
                              <Button
                                variant="outline"
                                size="icon"
                                className="size-7"
                                disabled={busy}
                                onClick={() => void step(row.id, 1)}
                                aria-label="زيادة"
                              >
                                <Plus className="size-3" aria-hidden />
                              </Button>
                            </>
                          )}
                        </div>
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
