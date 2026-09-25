import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Lock, LockOpen, Wallet } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { closeRegister, openRegister } from "@/lib/rpc";
import { computeExpectedCash, computeVariance, summarizeSalesByMethod, type MethodTotals } from "@/lib/cashreport";
import { useStore } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";
import { formatDA, formatDateTime } from "@/lib/format";
import type { RegisterSessionRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type SessionReport = {
  methodTotals: MethodTotals;
  saleCount: number;
  cashSalesGross: number;
  cashRefunds: number;
  cashPayments: number;
  cashExpenses: number;
  expectedSelf: number;
};

/**
 * Cash register open/close (item 5) + cash report (item 6), Phase A.
 * Open/close go through the exact same open_register()/close_register()
 * SECURITY DEFINER RPCs SUMA Web's own cash-report screen already calls —
 * explicitly online-only (a register session is a single cross-device
 * fact, never safe to queue offline — see the isOnline gates below).
 *
 * The report tab computes its OWN expected-cash total, keyed on
 * `occurred_at` (the real sale moment) instead of `created_at` (sync
 * time) — see lib/cashreport.ts's header comment for why: close_register()
 * itself still uses `created_at`, a known, pre-existing server-side bug
 * for any offline-synced sale, left unfixed here (no access to that
 * migration from Desktop). Both numbers are shown side by side so a
 * mismatch is visible instead of silently trusted.
 */
export function CashRegisterPage() {
  const { active, perms } = useStore();
  const { isOnline } = useSync();
  const storeId = active!.id;

  const [loading, setLoading] = useState(true);
  const [currentSession, setCurrentSession] = useState<RegisterSessionRow | null>(null);
  const [recentSessions, setRecentSessions] = useState<RegisterSessionRow[]>([]);

  const [openingBalance, setOpeningBalance] = useState("");
  const [openNotes, setOpenNotes] = useState("");
  const [opening, setOpening] = useState(false);

  const [countedCash, setCountedCash] = useState("");
  const [closeNotes, setCloseNotes] = useState("");
  const [closing, setClosing] = useState(false);

  const [reportSessionId, setReportSessionId] = useState<string | null>(null);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);

  async function loadSessions() {
    setLoading(true);
    const [openRes, recentRes] = await Promise.all([
      supabase.from("register_sessions").select("*").eq("store_id", storeId).eq("status", "open").maybeSingle(),
      supabase.from("register_sessions").select("*").eq("store_id", storeId).order("opened_at", { ascending: false }).limit(20),
    ]);
    setLoading(false);
    if (openRes.error) {
      toast.error(openRes.error.message);
      return;
    }
    setCurrentSession(openRes.data ?? null);
    setRecentSessions(recentRes.data ?? []);
    if (!reportSessionId) setReportSessionId(openRes.data?.id ?? recentRes.data?.[0]?.id ?? null);
  }

  useEffect(() => {
    void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function loadReport(sessionId: string) {
    const session = [currentSession, ...recentSessions].find((s) => s?.id === sessionId);
    if (!session) return;
    setLoadingReport(true);
    const windowEnd = session.closed_at ?? new Date().toISOString();

    const [salesRes, cashRefundsRes, paymentsRes, expensesRes] = await Promise.all([
      supabase
        .from("sales")
        .select("total_amount, refunded_amount, payment_method")
        .eq("store_id", storeId)
        .gte("occurred_at", session.opened_at)
        .lte("occurred_at", windowEnd),
      supabase
        .from("sales")
        .select("refunded_amount")
        .eq("store_id", storeId)
        .eq("payment_method", "cash")
        .not("refunded_at", "is", null)
        .gte("refunded_at", session.opened_at)
        .lte("refunded_at", windowEnd),
      supabase.from("customer_payments").select("amount").eq("store_id", storeId).gte("created_at", session.opened_at).lte("created_at", windowEnd),
      supabase.from("expenses").select("amount").eq("store_id", storeId).gte("created_at", session.opened_at).lte("created_at", windowEnd),
    ]);
    setLoadingReport(false);

    const sales = salesRes.data ?? [];
    const methodTotals = summarizeSalesByMethod(sales);
    const cashSalesGross = sales.filter((s) => s.payment_method === "cash").reduce((sum, s) => sum + Number(s.total_amount), 0);
    const cashRefunds = (cashRefundsRes.data ?? []).reduce((sum, r) => sum + Number(r.refunded_amount), 0);
    const cashPayments = (paymentsRes.data ?? []).reduce((sum, p) => sum + Number(p.amount), 0);
    const cashExpenses = (expensesRes.data ?? []).reduce((sum, e) => sum + Number(e.amount), 0);
    const expectedSelf = computeExpectedCash({ openingBalance: Number(session.opening_balance), cashSalesGross, cashRefunds, cashPayments, cashExpenses });

    setReport({ methodTotals, saleCount: sales.length, cashSalesGross, cashRefunds, cashPayments, cashExpenses, expectedSelf });
  }

  useEffect(() => {
    if (reportSessionId) void loadReport(reportSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportSessionId, currentSession, recentSessions]);

  async function submitOpen() {
    const balance = Number(openingBalance) || 0;
    if (balance < 0) return toast.error("الرصيد الافتتاحي غير صالح.");
    setOpening(true);
    const { data, error } = await openRegister({ _store_id: storeId, _opening_balance: balance, _notes: openNotes.trim() || undefined });
    setOpening(false);
    if (error) return toast.error(error.message);
    toast.success("تم فتح الصندوق.");
    setOpeningBalance("");
    setOpenNotes("");
    if (data) setReportSessionId(data.id);
    void loadSessions();
  }

  async function submitClose() {
    if (!currentSession) return;
    const counted = Number(countedCash);
    if (!(counted >= 0)) return toast.error("المبلغ المعدود غير صالح.");
    setClosing(true);
    const { error } = await closeRegister({
      _session_id: currentSession.id,
      _store_id: storeId,
      _counted_cash: counted,
      _notes: closeNotes.trim() || undefined,
    });
    setClosing(false);
    if (error) return toast.error(error.message);
    toast.success("تم إغلاق الصندوق.");
    setCountedCash("");
    setCloseNotes("");
    void loadSessions();
  }

  if (loading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }

  const reportSession = [currentSession, ...recentSessions].find((s) => s?.id === reportSessionId) ?? null;
  const selfVsServerMismatch =
    reportSession?.status === "closed" &&
    report &&
    reportSession.expected_cash !== null &&
    Math.abs(Number(reportSession.expected_cash) - report.expectedSelf) > 0.01;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="grid size-9 place-items-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
          <Wallet className="size-4.5" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-black tracking-tight">الصندوق</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">فتح/إغلاق الصندوق وتقرير المطابقة النقدية.</p>
        </div>
      </div>

      {!perms.canUsePos ? (
        <div className="surface p-6 text-center text-sm text-muted-foreground">ما عندكش صلاحية استعمال الصندوق.</div>
      ) : (
        <Tabs defaultValue="status">
          <TabsList>
            <TabsTrigger value="status">حالة الصندوق</TabsTrigger>
            <TabsTrigger value="report">تقرير المطابقة</TabsTrigger>
          </TabsList>

          <TabsContent value="status">
            <div className="surface max-w-xl p-4">
              {currentSession ? (
                <>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="grid size-9 place-items-center rounded-lg bg-[var(--success)]/15 text-[var(--success)]">
                      <LockOpen className="size-4.5" aria-hidden />
                    </span>
                    <div>
                      <p className="font-bold">الصندوق مفتوح</p>
                      <p className="text-xs text-muted-foreground">
                        منذ {formatDateTime(currentSession.opened_at)} — {currentSession.opened_by_name ?? "—"}
                      </p>
                    </div>
                  </div>
                  <p className="mb-3 text-sm">
                    الرصيد الافتتاحي: <span className="num font-bold">{formatDA(currentSession.opening_balance)}</span>
                  </p>
                  <div className="space-y-2 border-t border-border pt-3">
                    <Label htmlFor="counted">المبلغ المعدود عند الإغلاق (دج)</Label>
                    <Input id="counted" type="number" min={0} value={countedCash} onChange={(e) => setCountedCash(e.target.value)} />
                    <Label htmlFor="close-notes">ملاحظات (اختياري)</Label>
                    <textarea
                      id="close-notes"
                      value={closeNotes}
                      onChange={(e) => setCloseNotes(e.target.value)}
                      rows={2}
                      className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    {!isOnline && (
                      <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                        <AlertTriangle className="size-3.5" aria-hidden />
                        إغلاق الصندوق يحتاج اتصال بالإنترنت — لا يمكن تأجيله للمزامنة لاحقًا.
                      </p>
                    )}
                    <Button className="w-full" disabled={closing || !isOnline} onClick={() => void submitClose()}>
                      {closing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Lock className="size-4" aria-hidden />}
                      إغلاق الصندوق
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="grid size-9 place-items-center rounded-lg bg-[var(--muted)] text-muted-foreground">
                      <Lock className="size-4.5" aria-hidden />
                    </span>
                    <p className="font-bold">الصندوق مغلق حاليًا</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="opening">الرصيد الافتتاحي (دج)</Label>
                    <Input id="opening" type="number" min={0} autoFocus value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} placeholder="0" />
                    <Label htmlFor="open-notes">ملاحظات (اختياري)</Label>
                    <textarea
                      id="open-notes"
                      value={openNotes}
                      onChange={(e) => setOpenNotes(e.target.value)}
                      rows={2}
                      className="flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    {!isOnline && (
                      <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                        <AlertTriangle className="size-3.5" aria-hidden />
                        فتح الصندوق يحتاج اتصال بالإنترنت.
                      </p>
                    )}
                    <Button className="w-full" disabled={opening || !isOnline} onClick={() => void submitOpen()}>
                      {opening ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <LockOpen className="size-4" aria-hidden />}
                      فتح الصندوق
                    </Button>
                  </div>
                </>
              )}
            </div>
          </TabsContent>

          <TabsContent value="report">
            <div className="surface max-w-2xl p-4">
              {!reportSessionId ? (
                <p className="py-8 text-center text-sm text-muted-foreground">لا توجد جلسات صندوق سابقة بعد — افتح الصندوق أولًا.</p>
              ) : (
              <>
              <div className="mb-3 flex items-center gap-2">
                <Label htmlFor="session-pick" className="shrink-0">الجلسة</Label>
                <select
                  id="session-pick"
                  value={reportSessionId ?? ""}
                  onChange={(e) => setReportSessionId(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {currentSession && (
                    <option value={currentSession.id}>
                      مفتوحة الآن — منذ {formatDateTime(currentSession.opened_at)}
                    </option>
                  )}
                  {recentSessions
                    .filter((s) => s.status === "closed")
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {formatDateTime(s.opened_at)} → {s.closed_at ? formatDateTime(s.closed_at) : "…"}
                      </option>
                    ))}
                </select>
              </div>

              {loadingReport || !report || !reportSession ? (
                <div className="grid place-items-center py-8">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
                </div>
              ) : (
                <>
                  <div className="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="rounded-lg bg-[var(--muted)] p-2">
                      <p className="text-muted-foreground">نقدًا</p>
                      <p className="num font-bold">{formatDA(report.methodTotals.cash)}</p>
                    </div>
                    <div className="rounded-lg bg-[var(--muted)] p-2">
                      <p className="text-muted-foreground">بطاقة</p>
                      <p className="num font-bold">{formatDA(report.methodTotals.card)}</p>
                    </div>
                    <div className="rounded-lg bg-[var(--muted)] p-2">
                      <p className="text-muted-foreground">كريدي</p>
                      <p className="num font-bold">{formatDA(report.methodTotals.credit)}</p>
                    </div>
                  </div>

                  <dl className="space-y-1.5 text-sm">
                    <Row label="الرصيد الافتتاحي" value={reportSession.opening_balance} />
                    <Row label="مبيعات نقدية (إجمالي)" value={report.cashSalesGross} />
                    <Row label="مرتجعات نقدية" value={-report.cashRefunds} />
                    <Row label="تسديد ديون الزبائن" value={report.cashPayments} />
                    <Row label="المصاريف" value={-report.cashExpenses} />
                    <div className="my-1 border-t border-border" />
                    <Row label="الرصيد النقدي المتوقع (محسوب هنا — حسب وقت البيع الفعلي)" value={report.expectedSelf} bold />
                    {reportSession.status === "closed" && (
                      <>
                        <Row label="الرصيد المعدود فعليًا" value={Number(reportSession.counted_cash)} bold />
                        {(() => {
                          const v = computeVariance(report.expectedSelf, Number(reportSession.counted_cash));
                          return (
                            <Row
                              label="الفرق (معدود − متوقع)"
                              value={v.variance}
                              bold
                              tone={v.isShort ? "bad" : v.isOver ? "warn" : undefined}
                            />
                          );
                        })()}
                      </>
                    )}
                  </dl>

                  {reportSession.status === "closed" && reportSession.expected_cash !== null && (
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      الرصيد المتوقع المسجَّل من طرف النظام وقت الإغلاق: <span className="num">{formatDA(reportSession.expected_cash)}</span>
                    </p>
                  )}

                  {selfVsServerMismatch && (
                    <div className="mt-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2.5 text-[11px]">
                      <p className="flex items-center gap-1.5 font-semibold text-[var(--warning-foreground)]">
                        <AlertTriangle className="size-3.5" aria-hidden />
                        الرقمان لا يتطابقان
                      </p>
                      <p className="mt-0.5 text-muted-foreground">
                        على الأرجح بسبب بيع تم بدون إنترنت وزُوِمن في يوم لاحق — الرقم أعلاه (المحسوب هنا) هو الأدق لأنه يعتمد
                        على وقت البيع الفعلي، عكس رقم النظام الذي يعتمد على وقت المزامنة.
                      </p>
                    </div>
                  )}
                </>
              )}
              </>
              )}
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function Row({ label, value, bold, tone }: { label: string; value: number; bold?: boolean; tone?: "bad" | "warn" }) {
  const negative = value < 0;
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className={`text-muted-foreground ${bold ? "font-semibold text-foreground" : ""}`}>{label}</dt>
      <dd
        className={`num ${bold ? "font-bold" : ""} ${
          tone === "bad" ? "text-destructive" : tone === "warn" ? "text-[var(--warning-foreground)]" : negative ? "text-destructive" : ""
        }`}
      >
        {negative ? "−" : ""}
        {formatDA(Math.abs(value))}
      </dd>
    </div>
  );
}
