import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { WorkBook } from "xlsx";
import { AlertTriangle, CheckCircle2, CloudOff, Download, FileSpreadsheet, Loader2, Upload, X } from "lucide-react";
import { importProducts } from "@/lib/rpc";
import { hydrate } from "@/lib/sync";
import { formatDA } from "@/lib/format";
import { useStore } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";
import type { ImportDuplicateStrategy, ImportProductRow } from "@/lib/database.types";
import {
  DUPLICATE_STRATEGY_LABEL,
  IMPORT_CHUNK_SIZE,
  IMPORT_FIELDS,
  PREVIEW_STATUS_LABEL,
  TEMPLATE_FILE_NAME,
  TEMPLATE_HEADERS,
  TEMPLATE_ROWS,
  TEMPLATE_SHEET_NAME,
  addCounts,
  buildFailedRowsCsv,
  chunk,
  emptyCounts,
  guessExtraBarcodeColumns,
  guessMapping,
  mergePreview,
  prepareRows,
  type ColumnMapping,
  type ImportCounts,
  type ImportField,
  type PrepareResult,
  type PreviewRow,
  type PreviewStatus,
} from "@/lib/productImport";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type Step = "upload" | "mapping" | "preview" | "importing" | "result";

const STEPS: Array<{ key: Step; label: string }> = [
  { key: "upload", label: "رفع الملف" },
  { key: "mapping", label: "مطابقة الأعمدة" },
  { key: "preview", label: "معاينة" },
  { key: "importing", label: "استيراد" },
  { key: "result", label: "النتيجة" },
];

const MAX_ROWS = 20_000;
const PREVIEW_PAGE = 50;

type PreviewFilter = "all" | "new" | "update" | "error";
const PREVIEW_FILTERS: Array<{ key: PreviewFilter; label: string }> = [
  { key: "all", label: "الكل" },
  { key: "new", label: "جديد" },
  { key: "update", label: "تحديث" },
  { key: "error", label: "أخطاء" },
];

const STATUS_CLASS: Record<PreviewStatus, string> = {
  new: "bg-[var(--success)]/15 text-[var(--success)]",
  update: "bg-[var(--primary)]/10 text-[var(--primary)]",
  skip: "bg-[var(--muted)] text-muted-foreground",
  barcode_only: "bg-[var(--accent)]/25 text-foreground",
  error: "bg-[var(--destructive)]/10 text-destructive",
};

type FailedRow = { line: number; name: string; reason: string };

type ImportReport = {
  counts: ImportCounts;
  skippedTotals: number;
  warnings: Array<{ row: number; note: string }>;
  failed: FailedRow[];
  stoppedReason: string | null;
};

function downloadBlob(content: BlobPart, fileName: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** .csv is decoded here (UTF-8, falling back to Windows-1256 — the usual
 * encoding of Arabic CSVs saved by Excel on Windows) and parsed with
 * raw: true so every cell stays text (a barcode's leading zeros survive).
 * .xlsx/.xls go straight to SheetJS. */
async function readWorkbook(file: File): Promise<WorkBook> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  if (file.name.toLowerCase().endsWith(".csv")) {
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("�")) text = new TextDecoder("windows-1256").decode(buf);
    return XLSX.read(text.replace(/^﻿/, ""), { type: "string", raw: true });
  }
  return XLSX.read(buf, { type: "array" });
}

/**
 * Excel/CSV product importer. Everything decisive happens server-side in
 * import_products (one transaction per 500-row chunk, per-row
 * sub-transactions, duplicate detection, permissions, owner-only price
 * changes, stock through the ledger); this screen maps columns, validates
 * what it can locally, shows the dry-run preview, then imports only rows
 * with no client or dry-run error, chunk by chunk, cancellable between
 * chunks. Online-only.
 */
export function ProductImportDialog({
  storeId,
  onClose,
  onImported,
}: {
  storeId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const { userId } = useStore();
  const { isOnline } = useSync();

  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [reading, setReading] = useState(false);
  const [workbook, setWorkbook] = useState<WorkBook | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Array<Record<string, unknown>>>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [extraColumns, setExtraColumns] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<ImportDuplicateStrategy>("update");

  const [prepared, setPrepared] = useState<PrepareResult | null>(null);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewProgress, setPreviewProgress] = useState({ done: 0, of: 0 });
  const [filter, setFilter] = useState<PreviewFilter>("all");
  const [page, setPage] = useState(0);

  const [importProgress, setImportProgress] = useState({ done: 0, of: 0 });
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRef = useRef(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File) {
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (!ext || !["xlsx", "xls", "csv"].includes(ext)) {
      toast.error("الملف لازم يكون Excel (.xlsx / .xls) أو CSV.");
      return;
    }
    setReading(true);
    try {
      const wb = await readWorkbook(file);
      if (wb.SheetNames.length === 0) {
        toast.error("الملف فارغ أو ما قدرناش نقراه.");
        return;
      }
      setFileName(file.name);
      setWorkbook(wb);
      await loadSheet(wb, wb.SheetNames[0]);
    } catch (error) {
      toast.error(`ما قدرناش نقراو الملف: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setReading(false);
    }
  }

  async function loadSheet(wb: WorkBook, name: string) {
    const XLSX = await import("xlsx");
    const sheet = wb.Sheets[name];
    // raw: false reads the DISPLAYED text (keeps "0012345" barcodes intact);
    // dateNF makes date cells come out as YYYY-MM-DD instead of m/d/yy.
    const json = sheet
      ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false, dateNF: "yyyy-mm-dd" })
      : [];
    setSheetName(name);
    if (json.length === 0) {
      setHeaders([]);
      setRawRows([]);
      toast.error("هذي الورقة فارغة.");
      return;
    }
    if (json.length > MAX_ROWS) {
      setHeaders([]);
      setRawRows([]);
      toast.error(`الملف فيه أكثر من ${MAX_ROWS.toLocaleString("fr-FR")} سطر — قسّمه لعدة ملفات.`);
      return;
    }
    const cols = Object.keys(json[0]);
    const guessed = guessMapping(cols);
    setHeaders(cols);
    setRawRows(json);
    setMapping(guessed);
    setExtraColumns(guessExtraBarcodeColumns(cols, guessed.barcode));
    setPrepared(null);
    setPreview([]);
    setStep("mapping");
  }

  function setField(field: ImportField, column: string) {
    setMapping((prev) => {
      const next = { ...prev };
      if (column) next[field] = column;
      else delete next[field];
      return next;
    });
    if (field === "barcode" && column) setExtraColumns((cols) => cols.filter((c) => c !== column));
  }

  function toggleExtraColumn(column: string) {
    setExtraColumns((cols) => (cols.includes(column) ? cols.filter((c) => c !== column) : [...cols, column]));
  }

  async function runPreview(nextStrategy: ImportDuplicateStrategy = strategy) {
    if (!isOnline) return toast.error("المعاينة تحتاج اتصالاً بالإنترنت.");
    if (!mapping.name) return toast.error("لازم تحدد عمود اسم المنتج.");
    const prep = prepareRows(rawRows, mapping, extraColumns);
    if (prep.rows.length === 0) return toast.error("ما لقينا حتى منتج في الملف (كل الأسطر بلا اسم أو أسطر مجموع).");
    const clean = prep.rows.filter((r) => r.errors.length === 0).map((r) => r.payload);
    const pieces = chunk(clean, IMPORT_CHUNK_SIZE);
    setPreviewing(true);
    setPreviewProgress({ done: 0, of: pieces.length });
    const results: Parameters<typeof mergePreview>[1]["results"] = [];
    const warnings: Array<{ row: number; note: string }> = [];
    for (const piece of pieces) {
      const { data, error } = await importProducts({
        _store_id: storeId,
        _rows: piece,
        _duplicate_strategy: nextStrategy,
        _dry_run: true,
      });
      if (error || !data) {
        setPreviewing(false);
        toast.error(`تعذّرت المعاينة: ${error?.message ?? "استجابة فارغة من الخادم."}`);
        return;
      }
      results.push(...data.results);
      warnings.push(...data.warnings);
      setPreviewProgress((p) => ({ ...p, done: p.done + 1 }));
    }
    setPrepared(prep);
    setPreview(mergePreview(prep.rows, { results, warnings }));
    setFilter("all");
    setPage(0);
    setPreviewing(false);
    setStep("preview");
  }

  async function runImport() {
    if (!isOnline) return toast.error("الاستيراد يحتاج اتصالاً بالإنترنت.");
    const importable = preview.filter((r) => r.importable);
    if (importable.length === 0) return toast.error("ما كانش صفوف صالحة للاستيراد.");
    const pieces = chunk(importable, IMPORT_CHUNK_SIZE);
    cancelRef.current = false;
    setCancelRequested(false);
    setImportProgress({ done: 0, of: pieces.length });
    setStep("importing");

    let counts = emptyCounts();
    const warnings: Array<{ row: number; note: string }> = [];
    const failed: FailedRow[] = preview
      .filter((r) => !r.importable)
      .map((r) => ({ line: r.line, name: r.name, reason: r.reason ?? "خطأ" }));
    let stoppedReason: string | null = null;

    for (let i = 0; i < pieces.length; i += 1) {
      if (cancelRef.current) {
        stoppedReason = "أُلغي الاستيراد — الدفعات المتبقية لم تُرسل.";
        for (const r of pieces.slice(i).flat()) failed.push({ line: r.line, name: r.name, reason: "لم يُستورد (أُلغي الاستيراد)." });
        break;
      }
      const rows: ImportProductRow[] = pieces[i].map((r) => r.payload);
      const { data, error } = await importProducts({
        _store_id: storeId,
        _rows: rows,
        _duplicate_strategy: strategy,
        _dry_run: false,
      });
      if (error || !data) {
        const message = error?.message ?? "استجابة فارغة من الخادم.";
        stoppedReason = `توقف الاستيراد عند الدفعة ${i + 1} من ${pieces.length}: ${message}`;
        for (const r of pieces.slice(i).flat()) failed.push({ line: r.line, name: r.name, reason: `لم يُستورد: ${message}` });
        break;
      }
      counts = addCounts(counts, data);
      warnings.push(...data.warnings);
      for (const res of data.results) {
        if (res.status === "error") failed.push({ line: res.row, name: res.name ?? "", reason: res.reason ?? "خطأ" });
      }
      setImportProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    failed.sort((a, b) => a.line - b.line);
    counts = { ...counts, failed: failed.length };
    setReport({ counts, skippedTotals: prepared?.skippedTotals.length ?? 0, warnings, failed, stoppedReason });
    setStep("result");

    if (counts.created + counts.updated + counts.barcode_only > 0) {
      toast.success(`تم استيراد ${counts.created + counts.updated} منتج.`);
      onImported();
      // POS reads only the local mirror — refresh it now instead of waiting
      // for the next 30-second sync cycle.
      if (userId) {
        const res = await hydrate(storeId, userId);
        if (!res.ok) toast.error("تم الاستيراد، لكن تحديث نسخة نقطة البيع المحلية تأجل للمزامنة القادمة.");
      }
    }
  }

  function downloadTemplate() {
    void (async () => {
      const XLSX = await import("xlsx");
      const ws = XLSX.utils.json_to_sheet(TEMPLATE_ROWS, { header: [...TEMPLATE_HEADERS] });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, TEMPLATE_SHEET_NAME);
      XLSX.writeFile(wb, TEMPLATE_FILE_NAME);
    })();
  }

  function downloadFailed(rows: FailedRow[]) {
    downloadBlob(buildFailedRowsCsv(rows), "أخطاء-الاستيراد.csv", "text/csv;charset=utf-8;");
  }

  const counts = useMemo(() => {
    const c: Record<PreviewStatus, number> = { new: 0, update: 0, skip: 0, barcode_only: 0, error: 0 };
    for (const r of preview) c[r.status] += 1;
    return c;
  }, [preview]);

  const filtered = useMemo(() => (filter === "all" ? preview : preview.filter((r) => r.status === filter)), [preview, filter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PREVIEW_PAGE));
  const pageRows = filtered.slice(page * PREVIEW_PAGE, (page + 1) * PREVIEW_PAGE);
  const importableCount = preview.filter((r) => r.importable).length;
  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const busy = reading || previewing || step === "importing";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => !busy && onClose()}>
      <div className="surface flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <FileSpreadsheet className="size-5 text-[var(--primary)]" aria-hidden />
          <div>
            <h1 className="text-lg font-bold">استيراد منتجات من Excel</h1>
            {fileName && <p className="text-xs text-muted-foreground">{fileName}{sheetName ? ` — ${sheetName}` : ""}</p>}
          </div>
          <Button variant="ghost" size="icon" className="ms-auto" disabled={busy} onClick={onClose} aria-label="إغلاق">
            <X className="size-5" aria-hidden />
          </Button>
        </header>

        <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2 text-xs">
          {STEPS.map((s, i) => (
            <span
              key={s.key}
              className={
                i === stepIndex
                  ? "rounded-full bg-[var(--primary)] px-2.5 py-1 font-bold text-[var(--primary-foreground)]"
                  : i < stepIndex
                    ? "rounded-full bg-[var(--primary)]/10 px-2.5 py-1 font-semibold text-[var(--primary)]"
                    : "rounded-full bg-[var(--muted)] px-2.5 py-1 text-muted-foreground"
              }
            >
              {i + 1}. {s.label}
            </span>
          ))}
        </div>

        {!isOnline && step !== "result" && (
          <div className="flex items-center gap-2 border-b border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-2 text-xs">
            <CloudOff className="size-4 shrink-0 text-[var(--warning-foreground)]" aria-hidden />
            غير متصل — الاستيراد يحتاج اتصالاً بالإنترنت (المعاينة نفسها تتحقق من المنتجات الموجودة على الخادم).
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {/* ---- 1. Upload ---- */}
          {step === "upload" && (
            <div className="grid gap-4">
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
                <FileSpreadsheet className="size-9 text-muted-foreground" aria-hidden />
                <div>
                  <p className="font-bold">اختر ملف المنتجات</p>
                  <p className="text-sm text-muted-foreground">Excel (.xlsx / .xls) أو CSV — نتعرّف على الأعمدة تلقائيًا، عربي أو فرنسي أو إنجليزي.</p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleFile(file);
                    e.target.value = "";
                  }}
                />
                <Button disabled={reading || !isOnline} onClick={() => fileInputRef.current?.click()}>
                  {reading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />}
                  {reading ? "جاري القراءة..." : "اختيار ملف"}
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--muted)] p-3 text-xs">
                <p className="text-muted-foreground">
                  ما عندكش ملف جاهز؟ حمّل النموذج (نفس نموذج SUMA Web) وعبّيه: name, barcode, extra_barcodes, internal_code, selling_price,
                  purchase_price, stock_quantity, unit, category_name.
                </p>
                <Button variant="outline" size="sm" onClick={downloadTemplate}>
                  <Download className="size-4" aria-hidden />
                  تحميل النموذج
                </Button>
              </div>
            </div>
          )}

          {/* ---- 2. Mapping ---- */}
          {step === "mapping" && (
            <div className="grid gap-4">
              {workbook && workbook.SheetNames.length > 1 && (
                <div className="max-w-xs">
                  <Label htmlFor="imp-sheet">الورقة</Label>
                  <select
                    id="imp-sheet"
                    value={sheetName}
                    onChange={(e) => void loadSheet(workbook, e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {workbook.SheetNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                <span className="num font-semibold text-foreground">{rawRows.length}</span> سطر في الورقة. راجع مطابقة الأعمدة — اسم المنتج إجباري، والباقي اختياري
                (عمود غير مطابَق ما يبدّلش القيمة الموجودة عند التحديث).
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {IMPORT_FIELDS.map((f) => (
                  <div key={f.key}>
                    <Label htmlFor={`map-${f.key}`}>
                      {f.label}
                      {f.required ? " *" : ""}
                    </Label>
                    <select
                      id={`map-${f.key}`}
                      value={mapping[f.key] ?? ""}
                      onChange={(e) => setField(f.key, e.target.value)}
                      className={`h-9 w-full rounded-md border bg-background px-3 text-sm ${f.required && !mapping[f.key] ? "border-destructive" : "border-input"}`}
                    >
                      <option value="">— بدون —</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div>
                <Label>أعمدة باركودات إضافية</Label>
                <p className="mb-1.5 text-xs text-muted-foreground">كل قيمة فيها تُضاف كباركود إضافي (الخلية الواحدة تقبل عدة باركودات مفصولة بـ , أو ; أو |).</p>
                <div className="flex flex-wrap gap-1.5">
                  {headers
                    .filter((h) => h !== mapping.barcode)
                    .map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => toggleExtraColumn(h)}
                        className={
                          extraColumns.includes(h)
                            ? "rounded-full bg-[var(--primary)] px-3 py-1 text-xs font-bold text-[var(--primary-foreground)]"
                            : "rounded-full bg-[var(--muted)] px-3 py-1 text-xs font-semibold text-muted-foreground hover:bg-[var(--accent)]/20"
                        }
                      >
                        {h}
                      </button>
                    ))}
                </div>
              </div>
              <StrategyPicker value={strategy} onChange={setStrategy} disabled={previewing} />
            </div>
          )}

          {/* ---- 3. Preview ---- */}
          {step === "preview" && (
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                <Stat label="جديد" value={counts.new} tone="success" />
                <Stat label="تحديث" value={counts.update} tone="primary" />
                <Stat label="تجاهل" value={counts.skip + (prepared?.skippedTotals.length ?? 0)} />
                <Stat label="باركودات فقط" value={counts.barcode_only} />
                <Stat label="أخطاء" value={counts.error} tone="danger" />
                <Stat label="قابل للاستيراد" value={importableCount} tone="primary" />
              </div>
              {(prepared?.skippedTotals.length ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">
                  تم تجاهل {prepared?.skippedTotals.length} سطر مجموع (Total…) — الأسطر: {prepared?.skippedTotals.map((t) => t.line).join("، ")}.
                </p>
              )}
              {(prepared?.skippedEmpty ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">تم تجاهل {prepared?.skippedEmpty} سطر بدون اسم منتج.</p>
              )}
              <StrategyPicker
                value={strategy}
                disabled={previewing}
                onChange={(s) => {
                  setStrategy(s);
                  void runPreview(s);
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                {PREVIEW_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => {
                      setFilter(f.key);
                      setPage(0);
                    }}
                    className={
                      filter === f.key
                        ? "rounded-full bg-[var(--primary)] px-3 py-1.5 text-xs font-bold text-[var(--primary-foreground)]"
                        : "rounded-full bg-[var(--muted)] px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-[var(--accent)]/20"
                    }
                  >
                    {f.label}
                    <span className="ms-1 num">({f.key === "all" ? preview.length : counts[f.key]})</span>
                  </button>
                ))}
                {counts.error > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ms-auto"
                    onClick={() =>
                      downloadFailed(preview.filter((r) => r.status === "error").map((r) => ({ line: r.line, name: r.name, reason: r.reason ?? "خطأ" })))
                    }
                  >
                    <Download className="size-4" aria-hidden />
                    تحميل الأخطاء (CSV)
                  </Button>
                )}
              </div>
              <PreviewTable rows={pageRows} />
              {filtered.length > PREVIEW_PAGE && (
                <div className="flex items-center justify-between gap-3">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                    السابق
                  </Button>
                  <span className="text-xs text-muted-foreground num">
                    صفحة {page + 1} من {pageCount}
                  </span>
                  <Button variant="outline" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
                    التالي
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* ---- 4. Importing ---- */}
          {step === "importing" && (
            <div className="grid place-items-center gap-4 py-10 text-center">
              <Loader2 className="size-8 animate-spin text-[var(--primary)]" aria-hidden />
              <p className="font-bold">جاري الاستيراد...</p>
              <div className="h-2.5 w-full max-w-md overflow-hidden rounded-full bg-[var(--muted)]">
                <div
                  className="h-full rounded-full bg-[var(--primary)] transition-all"
                  style={{ width: `${importProgress.of ? (importProgress.done / importProgress.of) * 100 : 0}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground num">
                الدفعة {Math.min(importProgress.done + 1, importProgress.of)} من {importProgress.of} ({IMPORT_CHUNK_SIZE} صف لكل دفعة)
              </p>
              <Button
                variant="outline"
                disabled={cancelRequested}
                onClick={() => {
                  cancelRef.current = true;
                  setCancelRequested(true);
                }}
              >
                {cancelRequested ? "سيتوقف بعد الدفعة الحالية..." : "إلغاء بعد الدفعة الحالية"}
              </Button>
            </div>
          )}

          {/* ---- 5. Result ---- */}
          {step === "result" && report && (
            <div className="grid gap-4">
              <div className="flex items-center gap-2">
                {report.stoppedReason ? (
                  <AlertTriangle className="size-6 text-[var(--warning-foreground)]" aria-hidden />
                ) : (
                  <CheckCircle2 className="size-6 text-[var(--success)]" aria-hidden />
                )}
                <p className="font-bold">{report.stoppedReason ?? "انتهى الاستيراد."}</p>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Stat label="أُضيف" value={report.counts.created} tone="success" />
                <Stat label="حُدّث" value={report.counts.updated} tone="primary" />
                <Stat label="تُجوهل" value={report.counts.skipped + report.skippedTotals} />
                <Stat label="باركودات فقط" value={report.counts.barcode_only} />
                <Stat label="فشل" value={report.failed.length} tone="danger" />
              </div>
              {report.warnings.length > 0 && (
                <div className="rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3">
                  <p className="mb-1 text-sm font-bold">تنبيهات ({report.warnings.length})</p>
                  <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
                    {report.warnings.slice(0, 300).map((w, i) => (
                      <li key={i}>
                        <span className="num font-semibold">السطر {w.row}:</span> {w.note}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {report.failed.length > 0 && (
                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold">الأسطر التي لم تُستورد ({report.failed.length})</p>
                    <Button variant="outline" size="sm" onClick={() => downloadFailed(report.failed)}>
                      <Download className="size-4" aria-hidden />
                      تحميل CSV
                    </Button>
                  </div>
                  <div className="surface max-h-72 overflow-auto p-0">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
                          <th className="w-20 px-3 py-2 text-start font-bold">السطر</th>
                          <th className="px-3 py-2 text-start font-bold">الاسم</th>
                          <th className="px-3 py-2 text-start font-bold">السبب</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.failed.slice(0, 500).map((f, i) => (
                          <tr key={`${f.line}-${i}`} className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"}`}>
                            <td className="px-3 py-1.5 num">{f.line}</td>
                            <td className="px-3 py-1.5">{f.name}</td>
                            <td className="px-3 py-1.5 text-xs text-destructive">{f.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-border p-4">
          {step === "mapping" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")} disabled={previewing}>
                ملف آخر
              </Button>
              <Button className="ms-auto" disabled={!mapping.name || previewing || !isOnline} onClick={() => void runPreview()}>
                {previewing && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {previewing ? `جاري المعاينة (${previewProgress.done}/${previewProgress.of})...` : "معاينة"}
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("mapping")} disabled={previewing}>
                رجوع للمطابقة
              </Button>
              {previewing && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
              <Button className="ms-auto" disabled={importableCount === 0 || previewing || !isOnline} onClick={() => void runImport()}>
                استيراد {importableCount} صف
              </Button>
            </>
          )}
          {step === "result" && (
            <Button className="ms-auto" onClick={onClose}>
              إغلاق
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}

function StrategyPicker({
  value,
  onChange,
  disabled,
}: {
  value: ImportDuplicateStrategy;
  onChange: (s: ImportDuplicateStrategy) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <Label>إذا كان المنتج موجودًا من قبل (نفس الباركود أو الكود أو الاسم)</Label>
      <div className="mt-1 flex flex-wrap gap-2">
        {(Object.keys(DUPLICATE_STRATEGY_LABEL) as ImportDuplicateStrategy[]).map((s) => (
          <Button key={s} type="button" size="sm" variant={value === s ? "default" : "outline"} disabled={disabled} onClick={() => value !== s && onChange(s)}>
            {DUPLICATE_STRATEGY_LABEL[s]}
          </Button>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        التحديث يبدّل فقط الحقول الموجودة في الملف؛ تغيير سعر البيع محجوز لصاحب المحل؛ تغيير الكمية يُسجَّل كحركة مخزون.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "primary" | "danger" }) {
  const color =
    tone === "success" ? "text-[var(--success)]" : tone === "primary" ? "text-[var(--primary)]" : tone === "danger" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-xl bg-[var(--muted)] p-2.5 text-center">
      <p className={`text-xl font-black num ${color}`}>{value.toLocaleString("fr-FR")}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">ما كانش صفوف في هذا الفلتر.</p>;
  return (
    <div className="surface overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
            <th className="w-16 px-3 py-2 text-start font-bold">السطر</th>
            <th className="px-3 py-2 text-start font-bold">الاسم</th>
            <th className="px-3 py-2 text-start font-bold">الباركود</th>
            <th className="w-28 px-3 py-2 text-end font-bold">السعر</th>
            <th className="w-20 px-3 py-2 text-center font-bold">المخزون</th>
            <th className="w-28 px-3 py-2 text-center font-bold">الحالة</th>
            <th className="px-3 py-2 text-start font-bold">السبب / تنبيهات</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.line} className={`border-b border-border align-top last:border-0 ${i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"}`}>
              <td className="px-3 py-1.5 num">{r.line}</td>
              <td className="max-w-56 px-3 py-1.5">
                <span className="line-clamp-2">{r.name}</span>
              </td>
              <td className="px-3 py-1.5 text-xs text-muted-foreground num" dir="ltr">
                {r.barcode ?? "—"}
                {(r.payload.extra_barcodes?.length ?? 0) > 0 && (
                  <span className="block text-[10px]">+{r.payload.extra_barcodes?.length} إضافي</span>
                )}
              </td>
              <td className="px-3 py-1.5 text-end num">{r.sellingPrice === null ? "—" : formatDA(r.sellingPrice)}</td>
              <td className="px-3 py-1.5 text-center num">{r.stock === null ? "—" : r.stock}</td>
              <td className="px-3 py-1.5 text-center">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${STATUS_CLASS[r.status]}`}>{PREVIEW_STATUS_LABEL[r.status]}</span>
              </td>
              <td className="px-3 py-1.5 text-xs">
                {r.reason && <p className={r.status === "error" ? "text-destructive" : "text-muted-foreground"}>{r.reason}</p>}
                {r.warnings.map((w, j) => (
                  <p key={j} className="text-[var(--warning-foreground)]">
                    {w}
                  </p>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
