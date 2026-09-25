import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, ChevronLeft, Download, Loader2, Printer, Search, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { getCustomerStatement } from "@/lib/rpc";
import { friendlyCustomerError } from "@/lib/customerList";
import { formatDA, formatDateTime } from "@/lib/format";
import {
  buildStatementCsv,
  hasBalanceDrift,
  isSaleLinkedKind,
  isValidDateRange,
  localDayEndIso,
  localDayStartIso,
  shortRef,
  statementBatchOffsets,
  STATEMENT_BATCH_SIZE,
  STATEMENT_EXPORT_CAP,
  STATEMENT_KIND_FILTERS,
  STATEMENT_KIND_LABEL,
  STATEMENT_PAGE_SIZE,
} from "@/lib/customerStatement";
import type { CustomerRow, CustomerStatement, SaleItemRow, StatementKind, StatementLine } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LoadingRows, Pager } from "./shared";

type SaleItemLite = Pick<
  SaleItemRow,
  "id" | "product_name" | "variant_name" | "quantity" | "unit_price" | "line_total" | "refunded_quantity"
>;
type ItemsState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; items: SaleItemLite[] };

export type StatementPrintJob = {
  rows: StatementLine[];
  total: number;
  truncated: boolean;
  openingBalance: number;
  closingBalance: number;
  periodDebit: number;
  periodCredit: number;
  computedBalance: number;
  recordedBalance: number;
  fromDate: string;
  toDate: string;
  kinds: StatementKind[];
  search: string;
  printedAt: string;
};

const KIND_TONE: Record<StatementKind, string> = {
  credit_sale: "bg-[var(--destructive)]/10 text-destructive",
  cash_sale: "bg-[var(--muted)] text-muted-foreground",
  card_sale: "bg-[var(--muted)] text-muted-foreground",
  refund: "bg-[var(--warning)]/20 text-[var(--warning-foreground)]",
  payment: "bg-[var(--success)]/15 text-[var(--success)]",
};

function balanceTone(n: number): string {
  return n > 0 ? "text-destructive" : n < 0 ? "text-[var(--success)]" : "";
}

function Cell({ value }: { value: number }) {
  return value ? <span className="num">{formatDA(value)}</span> : <span className="text-muted-foreground">—</span>;
}

/**
 * كشف الحساب — paginated view over get_customer_statement(). Every balance
 * shown (opening/closing/running) comes from the RPC; the UI never adds
 * rows up itself. Print and CSV re-fetch the same filtered statement in
 * batches of 500 (capped) instead of relying on the on-screen page.
 */
export function CustomerStatementTab({
  customer,
  storeId,
  reloadKey,
  onCustomerRefreshed,
  onPrint,
}: {
  customer: CustomerRow;
  storeId: string;
  reloadKey: number;
  onCustomerRefreshed: (row: CustomerRow) => void;
  onPrint: (job: StatementPrintJob) => void;
}) {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [kinds, setKinds] = useState<StatementKind[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const searchRef = useRef("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<CustomerStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [itemsBySale, setItemsBySale] = useState<Record<string, ItemsState>>({});
  const [exporting, setExporting] = useState<"print" | "csv" | null>(null);
  const requestSeq = useRef(0);

  const rangeValid = isValidDateRange(fromDate, toDate);
  const kindsKey = kinds.join(",");

  // Debounced search box (reference id prefix or amount text).
  useEffect(() => {
    const t = setTimeout(() => {
      const next = searchInput.trim();
      if (next === searchRef.current) return;
      searchRef.current = next;
      setSearch(next);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const baseArgs = useMemo(() => {
    const from = fromDate ? localDayStartIso(fromDate) : null;
    const to = toDate ? localDayEndIso(toDate) : null;
    return {
      _customer_id: customer.id,
      _store_id: storeId,
      ...(from ? { _from: from } : {}),
      ...(to ? { _to: to } : {}),
      ...(kinds.length > 0 ? { _kinds: kinds } : {}),
      ...(search ? { _search: search } : {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer.id, storeId, fromDate, toDate, kindsKey, search]);

  async function load() {
    if (!rangeValid) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    const { data: res, error } = await getCustomerStatement({
      ...baseArgs,
      _limit: STATEMENT_PAGE_SIZE,
      _offset: page * STATEMENT_PAGE_SIZE,
    });
    if (seq !== requestSeq.current) return;
    setLoading(false);
    if (error || !res) {
      const message = error ? friendlyCustomerError(error.message) : "تعذر تحميل كشف الحساب.";
      setLoadError(message);
      toast.error(message);
      return;
    }
    setData(res);
    setExpanded(null);
    if (res.customer) onCustomerRefreshed(res.customer);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseArgs, page, reloadKey, rangeValid]);

  function toggleKind(kind: StatementKind) {
    setKinds((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));
    setPage(0);
  }

  function clearFilters() {
    setFromDate("");
    setToDate("");
    setKinds([]);
    setSearchInput("");
    setSearch("");
    searchRef.current = "";
    setPage(0);
  }

  async function toggleRow(key: string, line: StatementLine) {
    if (!isSaleLinkedKind(line.kind)) return;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    const saleId = line.reference_id;
    const cached = itemsBySale[saleId];
    if (cached && cached.status !== "error") return;
    setItemsBySale((prev) => ({ ...prev, [saleId]: { status: "loading" } }));
    const { data: items, error } = await supabase
      .from("sale_items")
      .select("id, product_name, variant_name, quantity, unit_price, line_total, refunded_quantity")
      .eq("sale_id", saleId);
    setItemsBySale((prev) => ({
      ...prev,
      [saleId]: error
        ? { status: "error", message: friendlyCustomerError(error.message) }
        : { status: "ok", items: (items ?? []) as unknown as SaleItemLite[] },
    }));
  }

  /** Whole filtered statement, newest first, in RPC-sized batches (capped
   * at STATEMENT_EXPORT_CAP). The first batch's total_count drives how
   * many more batches to request, so a stale on-screen page never does. */
  async function fetchAllFiltered(): Promise<{ statement: CustomerStatement; rows: StatementLine[] } | null> {
    const fetchBatch = async (offset: number) => {
      const { data: res, error } = await getCustomerStatement({ ...baseArgs, _limit: STATEMENT_BATCH_SIZE, _offset: offset });
      if (error || !res) {
        toast.error(error ? friendlyCustomerError(error.message) : "تعذر تحميل كشف الحساب.");
        return null;
      }
      return res;
    };
    const first = await fetchBatch(0);
    if (!first) return null;
    const rows: StatementLine[] = [...first.rows];
    for (const offset of statementBatchOffsets(first.total_count).slice(1)) {
      if (rows.length < offset) break; // an earlier batch came back short
      const res = await fetchBatch(offset);
      if (!res) return null;
      rows.push(...res.rows);
    }
    return { statement: first, rows: rows.slice(0, STATEMENT_EXPORT_CAP) };
  }

  async function exportCsv() {
    if (exporting) return;
    setExporting("csv");
    try {
      const all = await fetchAllFiltered();
      if (!all) return;
      const csv = buildStatementCsv({
        rows: all.rows,
        openingBalance: all.statement.opening_balance,
        closingBalance: all.statement.closing_balance,
      });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `suma-statement-${customer.phone.replace(/[^\d+]/g, "") || customer.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      const truncated = all.statement.total_count > all.rows.length;
      toast.success(
        truncated
          ? `تم تصدير أول ${all.rows.length} عملية من ${all.statement.total_count}.`
          : `تم تصدير ${all.rows.length} عملية.`,
      );
    } finally {
      setExporting(null);
    }
  }

  async function print() {
    if (exporting) return;
    setExporting("print");
    try {
      const all = await fetchAllFiltered();
      if (!all) return;
      const s = all.statement;
      onPrint({
        rows: all.rows,
        total: s.total_count,
        truncated: s.total_count > all.rows.length,
        openingBalance: Number(s.opening_balance),
        closingBalance: Number(s.closing_balance),
        periodDebit: Number(s.period_debit),
        periodCredit: Number(s.period_credit),
        computedBalance: Number(s.computed_balance),
        recordedBalance: Number(s.recorded_balance),
        fromDate,
        toDate,
        kinds,
        search,
        printedAt: new Date().toISOString(),
      });
    } finally {
      setExporting(null);
    }
  }

  const filtersActive = Boolean(fromDate || toDate || kinds.length > 0 || searchInput);
  const drift = data ? hasBalanceDrift(data.computed_balance, data.recorded_balance) : false;

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">من تاريخ</label>
          <Input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => {
              setFromDate(e.target.value);
              setPage(0);
            }}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">إلى تاريخ</label>
          <Input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => {
              setToDate(e.target.value);
              setPage(0);
            }}
          />
        </div>
        <div className="lg:col-span-2">
          <label className="mb-1 block text-xs text-muted-foreground">بحث بالمرجع أو المبلغ</label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 end-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              dir="ltr"
              className="pe-9 text-start"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="A1B2C3D4 / 1500"
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {STATEMENT_KIND_FILTERS.map((f) => {
          const on = kinds.includes(f.kind);
          return (
            <button
              key={f.kind}
              type="button"
              onClick={() => toggleKind(f.kind)}
              aria-pressed={on}
              className={
                on
                  ? "shrink-0 rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-bold text-[var(--primary-foreground)]"
                  : "shrink-0 rounded-full bg-[var(--muted)] px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-[var(--accent)]/20"
              }
            >
              {f.label}
            </button>
          );
        })}
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-3.5" aria-hidden />
            مسح الفلاتر
          </Button>
        )}
        <div className="ms-auto flex gap-1.5">
          <Button variant="outline" size="sm" disabled={!data || loading || exporting !== null || !rangeValid} onClick={() => void exportCsv()}>
            {exporting === "csv" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
            تصدير CSV
          </Button>
          <Button variant="outline" size="sm" disabled={!data || loading || exporting !== null || !rangeValid} onClick={() => void print()}>
            {exporting === "print" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Printer className="size-3.5" aria-hidden />}
            طباعة
          </Button>
        </div>
      </div>

      {!rangeValid && (
        <p className="rounded-lg bg-[var(--destructive)]/10 px-3 py-2 text-xs font-medium text-destructive">
          تاريخ البداية بعد تاريخ النهاية — صحّح الفترة.
        </p>
      )}

      {data && drift && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2.5 text-xs">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning-foreground)]" aria-hidden />
          <p>
            <span className="font-bold text-[var(--warning-foreground)]">تنبيه: عدم تطابق في الرصيد.</span> الرصيد المسجّل
            للزبون <span className="num font-bold">{formatDA(data.recorded_balance)}</span> بينما مجموع العمليات يعطي{" "}
            <span className="num font-bold">{formatDA(data.computed_balance)}</span> (الفرق{" "}
            <span className="num">{formatDA(Number(data.recorded_balance) - Number(data.computed_balance))}</span>). راجع
            العمليات أو تواصل مع الدعم.
          </p>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <SummaryTile label="رصيد افتتاحي" value={Number(data.opening_balance)} tone />
          <SummaryTile label="مدين الفترة" value={Number(data.period_debit)} />
          <SummaryTile label="دائن الفترة" value={Number(data.period_credit)} />
          <SummaryTile label="رصيد ختامي" value={Number(data.closing_balance)} tone strong />
        </div>
      )}

      <div className="surface overflow-hidden p-0">
        {loading && !data ? (
          <LoadingRows />
        ) : loadError && !data ? (
          <div className="flex flex-col items-center gap-2 py-10 text-sm">
            <p className="text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              إعادة المحاولة
            </Button>
          </div>
        ) : !data || data.rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {filtersActive ? "لا توجد عمليات مطابقة." : "ما كانش أي عملية بعد."}
          </p>
        ) : (
          <div className={cn("overflow-x-auto transition-opacity", loading && "opacity-60")}>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
                  <th className="w-8 px-2 py-2" />
                  <th className="px-3 py-2 text-start font-bold">التاريخ</th>
                  <th className="px-3 py-2 text-start font-bold">النوع</th>
                  <th className="px-3 py-2 text-start font-bold">المرجع</th>
                  <th className="px-3 py-2 text-center font-bold">المبلغ</th>
                  <th className="px-3 py-2 text-center font-bold">مدين</th>
                  <th className="px-3 py-2 text-center font-bold">دائن</th>
                  <th className="px-3 py-2 text-center font-bold">الرصيد</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((line, i) => {
                  const key = `${page}-${i}-${line.kind}-${line.reference_id}`;
                  const linked = isSaleLinkedKind(line.kind);
                  const open = expanded === key;
                  const items = itemsBySale[line.reference_id];
                  const bal = Number(line.balance_after);
                  return (
                    <Fragment key={key}>
                      <tr
                        onClick={() => void toggleRow(key, line)}
                        className={cn(
                          "border-b border-border transition-colors last:border-0",
                          i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white",
                          linked && "cursor-pointer hover:bg-[var(--accent)]/10",
                        )}
                      >
                        <td className="px-2 py-2 text-center text-muted-foreground">
                          {linked &&
                            (open ? <ChevronDown className="inline size-3.5" aria-hidden /> : <ChevronLeft className="inline size-3.5" aria-hidden />)}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{formatDateTime(line.occurred_at)}</td>
                        <td className="px-3 py-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold", KIND_TONE[line.kind])}>
                            {STATEMENT_KIND_LABEL[line.kind] ?? line.kind}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs num" dir="ltr" title={line.reference_id}>
                          {shortRef(line.reference_id)}
                        </td>
                        <td className="px-3 py-2 text-center num">{formatDA(line.amount)}</td>
                        <td className="px-3 py-2 text-center text-destructive">
                          <Cell value={Number(line.debit)} />
                        </td>
                        <td className="px-3 py-2 text-center text-[var(--success)]">
                          <Cell value={Number(line.credit)} />
                        </td>
                        <td className={cn("px-3 py-2 text-center font-bold num", balanceTone(bal))}>{formatDA(bal)}</td>
                      </tr>
                      {open && (
                        <tr className="border-b border-border bg-[var(--secondary)]/40">
                          <td />
                          <td colSpan={7} className="px-3 py-2">
                            <SaleItemsList state={items} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total_count > STATEMENT_PAGE_SIZE && (
          <Pager page={page} pageSize={STATEMENT_PAGE_SIZE} total={data.total_count} onPage={setPage} disabled={loading} />
        )}
      </div>
    </div>
  );
}

function SummaryTile({ label, value, tone, strong }: { label: string; value: number; tone?: boolean; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-background p-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("num", strong ? "text-base font-black" : "text-sm font-bold", tone && balanceTone(value))}>{formatDA(value)}</p>
    </div>
  );
}

function SaleItemsList({ state }: { state: ItemsState | undefined }) {
  if (!state || state.status === "loading") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        جاري تحميل الأصناف...
      </div>
    );
  }
  if (state.status === "error") return <p className="text-xs text-destructive">{state.message}</p>;
  if (state.items.length === 0) return <p className="text-xs text-muted-foreground">لا توجد أصناف.</p>;
  return (
    <ul className="divide-y divide-border text-xs">
      {state.items.map((it) => (
        <li key={it.id} className="flex items-center gap-2 py-1.5">
          <span className="flex-1 truncate">
            {it.product_name}
            {it.variant_name && <span className="text-muted-foreground"> — {it.variant_name}</span>}
            <span className="ms-1 text-muted-foreground num">
              × {Number(it.quantity)} @ {formatDA(it.unit_price)}
            </span>
          </span>
          {Number(it.refunded_quantity) > 0 && (
            <span className="rounded-full bg-[var(--destructive)]/10 px-2 py-0.5 text-[10px] font-bold text-destructive">
              مسترجع <span className="num">{Number(it.refunded_quantity)}</span>
            </span>
          )}
          <span className="font-medium num">{formatDA(it.line_total)}</span>
        </li>
      ))}
    </ul>
  );
}
