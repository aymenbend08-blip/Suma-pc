import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Loader2, Printer, Receipt, RotateCcw, Search, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { refundSale } from "@/lib/rpc";
import { printSaleReceipt } from "@/lib/printReceipt";
import { useStore } from "@/context/StoreContext";
import { formatDA, formatDateTime } from "@/lib/format";
import type { CustomerRow, SaleItemRow, SaleRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PAGE_SIZE = 20;

const PAYMENT_LABEL: Record<SaleRow["payment_method"], string> = {
  cash: "نقدًا",
  card: "بطاقة",
  credit: "كريدي",
};

/**
 * Full sales history (Phase A item 4) — direct, RLS-scoped paginated
 * reads over `sales`/`sale_items` (same tables/queries POSPage's own
 * return dialog already reads from, just with real filters + pagination
 * added, not a parallel data model or a new RPC). Reprint reuses item 1's
 * receipt template; refund reuses the exact same refund_sale() RPC
 * POSPage's return dialog already calls.
 */
export function SalesHistoryPage() {
  const { active, perms } = useStore();
  const storeId = active!.id;

  const [loading, setLoading] = useState(true);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [customerNames, setCustomerNames] = useState<Record<string, string>>({});

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<SaleRow["payment_method"] | "">("");
  const [cashierQuery, setCashierQuery] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");

  const [selected, setSelected] = useState<SaleRow | null>(null);
  const [selectedItems, setSelectedItems] = useState<SaleItemRow[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [returnQty, setReturnQty] = useState<Record<string, number>>({});
  const [refunding, setRefunding] = useState(false);
  const [printing, setPrinting] = useState(false);

  async function load() {
    setLoading(true);
    let query = supabase
      .from("sales")
      .select("*", { count: "exact" })
      .eq("store_id", storeId)
      .order("occurred_at", { ascending: false });

    if (dateFrom) query = query.gte("occurred_at", new Date(dateFrom).toISOString());
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      query = query.lte("occurred_at", end.toISOString());
    }
    if (paymentMethod) query = query.eq("payment_method", paymentMethod);
    if (cashierQuery.trim()) query = query.ilike("cashier_name", `%${cashierQuery.trim()}%`);

    // customer_id has no readable name of its own on `sales` — resolve
    // matching customer ids first (same two-step lookup pattern used
    // elsewhere in this app instead of relying on a PostgREST embedded
    // join, which needs schema metadata this hand-curated client doesn't
    // carry — see database.types.ts's own header comment).
    if (customerQuery.trim()) {
      const { data: matches } = await supabase
        .from("customers")
        .select("id")
        .eq("store_id", storeId)
        .ilike("full_name", `%${customerQuery.trim()}%`);
      const ids = (matches ?? []).map((m) => m.id);
      if (ids.length === 0) {
        setSales([]);
        setTotalCount(0);
        setLoading(false);
        return;
      }
      query = query.in("customer_id", ids);
    }

    const from = page * PAGE_SIZE;
    const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1);
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSales(data ?? []);
    setTotalCount(count ?? 0);

    const custIds = Array.from(new Set((data ?? []).map((s) => s.customer_id).filter((id): id is string => Boolean(id))));
    const missing = custIds.filter((id) => !(id in customerNames));
    if (missing.length > 0) {
      const { data: custs } = await supabase.from("customers").select("id, full_name").in("id", missing);
      if (custs) {
        setCustomerNames((prev) => {
          const next = { ...prev };
          for (const c of custs as Pick<CustomerRow, "id" | "full_name">[]) next[c.id] = c.full_name;
          return next;
        });
      }
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, page, dateFrom, dateTo, paymentMethod]);

  function applyTextFilters() {
    setPage(0);
    void load();
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  async function openDetail(sale: SaleRow) {
    setSelected(sale);
    setSelectedItems([]);
    setReturnQty({});
    setLoadingDetail(true);
    const { data, error } = await supabase.from("sale_items").select("*").eq("sale_id", sale.id);
    setLoadingDetail(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSelectedItems(data ?? []);
    const initial: Record<string, number> = {};
    for (const item of data ?? []) initial[item.id] = 0;
    setReturnQty(initial);
  }

  async function submitRefund() {
    if (!selected) return;
    const items = Object.entries(returnQty)
      .filter(([, qty]) => qty > 0)
      .map(([sale_item_id, quantity]) => ({ sale_item_id, quantity }));
    if (items.length === 0) {
      toast.error("حدّد كمية الإرجاع لصنف واحد على الأقل.");
      return;
    }
    setRefunding(true);
    const { data, error } = await refundSale({ _sale_id: selected.id, _store_id: storeId, _items: items });
    setRefunding(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("تم تسجيل الإرجاع بنجاح.");
    if (data) {
      setSelected(data);
      setSales((prev) => prev.map((s) => (s.id === data.id ? data : s)));
    }
    void openDetail(data ?? selected);
  }

  async function reprint(sale: SaleRow, items: SaleItemRow[]) {
    if (!active) return;
    setPrinting(true);
    const res = await printSaleReceipt({
      store: active,
      sale,
      items: items.map((i) => ({ name: i.product_name, quantity: Number(i.quantity), unitPrice: Number(i.unit_price), lineTotal: Number(i.line_total) })),
      customerName: sale.customer_id ? (customerNames[sale.customer_id] ?? null) : null,
    });
    setPrinting(false);
    if (!res.ok) toast.error("تعذرت الطباعة — تحقق من الطابعة الافتراضية.");
  }

  const filtersActive = useMemo(
    () => Boolean(dateFrom || dateTo || paymentMethod || cashierQuery || customerQuery),
    [dateFrom, dateTo, paymentMethod, cashierQuery, customerQuery],
  );

  function clearFilters() {
    setDateFrom("");
    setDateTo("");
    setPaymentMethod("");
    setCashierQuery("");
    setCustomerQuery("");
    setPage(0);
    setTimeout(() => void load(), 0);
  }

  return (
    <div className="space-y-3">
      <div className="surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
            <Receipt className="size-4" aria-hidden />
          </span>
          <h1 className="text-lg font-bold">سجل المبيعات</h1>
          {filtersActive && (
            <Button variant="ghost" size="sm" className="ms-auto" onClick={clearFilters}>
              <X className="size-3.5" aria-hidden />
              مسح الفلاتر
            </Button>
          )}
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">من تاريخ</label>
            <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0); }} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">إلى تاريخ</label>
            <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0); }} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">طريقة الدفع</label>
            <select
              value={paymentMethod}
              onChange={(e) => { setPaymentMethod(e.target.value as SaleRow["payment_method"] | ""); setPage(0); }}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">الكل</option>
              <option value="cash">نقدًا</option>
              <option value="card">بطاقة</option>
              <option value="credit">كريدي</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">الكاشير</label>
            <div className="flex gap-1">
              <Input value={cashierQuery} onChange={(e) => setCashierQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyTextFilters()} placeholder="اسم الكاشير..." />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">الزبون</label>
            <div className="flex gap-1">
              <Input value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyTextFilters()} placeholder="اسم الزبون..." />
              <Button type="button" variant="outline" size="icon" onClick={applyTextFilters}>
                <Search className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="surface overflow-hidden p-0">
        {loading ? (
          <div className="grid place-items-center py-10">
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : sales.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">لا توجد مبيعات مطابقة.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
                <th className="px-3 py-2 text-start font-bold">التاريخ</th>
                <th className="px-3 py-2 text-start font-bold">الكاشير</th>
                <th className="px-3 py-2 text-start font-bold">الزبون</th>
                <th className="px-3 py-2 text-center font-bold">الدفع</th>
                <th className="px-3 py-2 text-center font-bold">الأصناف</th>
                <th className="px-3 py-2 text-center font-bold">المجموع</th>
                <th className="px-3 py-2 text-center font-bold">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((s, i) => (
                <tr
                  key={s.id}
                  onClick={() => void openDetail(s)}
                  className={`cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-[var(--accent)]/10 ${i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"}`}
                >
                  <td className="px-3 py-2 text-xs text-muted-foreground num" dir="ltr">{formatDateTime(s.occurred_at)}</td>
                  <td className="px-3 py-2">{s.cashier_name ?? "—"}</td>
                  <td className="px-3 py-2">{s.customer_id ? (customerNames[s.customer_id] ?? "…") : "—"}</td>
                  <td className="px-3 py-2 text-center text-xs">{PAYMENT_LABEL[s.payment_method]}</td>
                  <td className="px-3 py-2 text-center num">{s.item_count}</td>
                  <td className="px-3 py-2 text-center font-bold num">{formatDA(s.total_amount)}</td>
                  <td className="px-3 py-2 text-center">
                    {Number(s.refunded_amount) > 0 ? (
                      <span className="rounded-full bg-[var(--destructive)]/10 px-2 py-0.5 text-[10px] font-bold text-destructive">
                        مسترجع {formatDA(s.refunded_amount)}
                      </span>
                    ) : (
                      <span className="rounded-full bg-[var(--success)]/15 px-2 py-0.5 text-[10px] font-bold text-[var(--success)]">مكتمل</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <span>
            {totalCount > 0 ? `عرض ${page * PAGE_SIZE + 1}–${Math.min(totalCount, (page + 1) * PAGE_SIZE)} من ${totalCount}` : ""}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="size-7" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              <ChevronRight className="size-3.5" aria-hidden />
            </Button>
            <span className="num">{page + 1} / {totalPages}</span>
            <Button variant="outline" size="icon" className="size-7" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronLeft className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setSelected(null)}>
          <div className="surface flex max-h-[85vh] w-full max-w-lg flex-col p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="font-bold">تفاصيل الفاتورة</h2>
              <Button variant="ghost" size="icon" className="ms-auto" onClick={() => setSelected(null)}>
                <X className="size-4" aria-hidden />
              </Button>
            </div>
            <p className="mb-1 text-xs text-muted-foreground num" dir="ltr">{formatDateTime(selected.occurred_at)}</p>
            <p className="mb-3 text-xs text-muted-foreground">
              الكاشير: {selected.cashier_name ?? "—"} · الدفع: {PAYMENT_LABEL[selected.payment_method]}
              {selected.customer_id && ` · الزبون: ${customerNames[selected.customer_id] ?? "…"}`}
            </p>

            {loadingDetail ? (
              <div className="grid place-items-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
              </div>
            ) : (
              <>
                <ul className="max-h-64 divide-y divide-border overflow-y-auto">
                  {selectedItems.map((item) => {
                    const maxQty = item.quantity - item.refunded_quantity;
                    return (
                      <li key={item.id} className="flex items-center gap-2 py-2 text-sm">
                        <span className="flex-1 truncate">
                          {item.product_name}
                          <span className="ms-1 text-xs text-muted-foreground num">
                            × {item.quantity} @ {formatDA(item.unit_price)}
                          </span>
                        </span>
                        <span className="text-xs font-medium num">{formatDA(item.line_total)}</span>
                        {perms.canRefund && (
                          <Input
                            type="number"
                            min={0}
                            max={maxQty}
                            disabled={maxQty <= 0}
                            value={returnQty[item.id] || ""}
                            onChange={(e) =>
                              setReturnQty((q) => ({ ...q, [item.id]: Math.max(0, Math.min(maxQty, Number(e.target.value) || 0)) }))
                            }
                            className="w-14"
                            placeholder="إرجاع"
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>

                <div className="mt-2 space-y-1 border-t border-border pt-2 text-sm">
                  {Number(selected.discount_amount) > 0 && (
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>الخصم</span>
                      <span className="num">-{formatDA(selected.discount_amount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold">
                    <span>الإجمالي</span>
                    <span className="num">{formatDA(selected.total_amount)}</span>
                  </div>
                  {Number(selected.refunded_amount) > 0 && (
                    <div className="flex justify-between text-xs font-medium text-destructive">
                      <span>مسترجع</span>
                      <span className="num">{formatDA(selected.refunded_amount)}</span>
                    </div>
                  )}
                </div>

                <div className="mt-3 flex gap-2">
                  <Button variant="outline" className="flex-1" disabled={printing} onClick={() => void reprint(selected, selectedItems)}>
                    {printing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Printer className="size-4" aria-hidden />}
                    إعادة طباعة
                  </Button>
                  {perms.canRefund && (
                    <Button className="flex-1" disabled={refunding} onClick={() => void submitRefund()}>
                      {refunding ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCcw className="size-4" aria-hidden />}
                      تأكيد الإرجاع
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
