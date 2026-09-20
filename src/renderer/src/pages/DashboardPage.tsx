import { useEffect, useState } from "react";
import { BarChart3, Loader2, TrendingUp, Users, PackageX, Receipt, Wallet, TrendingDown } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useStore } from "@/context/StoreContext";
import { formatDA } from "@/lib/format";
import { computeProfit } from "@/lib/profit";

type MethodTotals = { cash: number; card: number; credit: number };
type ProfitSummary = { revenue: number; cost: number; margin: number; expenses: number; netProfit: number; unknownCostRevenue: number };

/**
 * Real numbers, straight from Supabase (the same authenticated, RLS-scoped
 * client every other screen uses) — no local SQLite fallback, since this is
 * an owner-facing rollup that should never silently show a stale offline
 * snapshot as if it were current. Deliberately a first cut (today's sales,
 * payment-method split, outstanding credit, low stock) — more views
 * (trends, top products, date ranges) are meant to build on this later.
 *
 * Profit/loss uses the exact same estimation SUMA Web's cash-report
 * ("تقرير المحاسبة", getCashReport in pos.functions.ts) already does:
 * revenue net of refunds, cost from each sold line's product's CURRENT
 * purchase_price (sale_items carries no cost snapshot of its own — the
 * same approximation Web accepts, not something new invented here),
 * margin = revenue - cost, net profit = margin - today's expenses. Ported
 * to "today" scope to match every other tile on this screen, rather than
 * building a separate date-range report screen.
 */
export function DashboardPage() {
  const { active } = useStore();
  const storeId = active!.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [todayTotal, setTodayTotal] = useState(0);
  const [todayCount, setTodayCount] = useState(0);
  const [byMethod, setByMethod] = useState<MethodTotals>({ cash: 0, card: 0, credit: 0 });
  const [totalDebt, setTotalDebt] = useState(0);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [profit, setProfit] = useState<ProfitSummary>({ revenue: 0, cost: 0, margin: 0, expenses: 0, netProfit: 0, unknownCostRevenue: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const todayDate = startOfDay.toISOString().slice(0, 10);

      const [salesRes, customersRes, lowStockRes, expensesRes] = await Promise.all([
        supabase
          .from("sales")
          .select("id, total_amount, refunded_amount, payment_method")
          .eq("store_id", storeId)
          .gte("occurred_at", startOfDay.toISOString()),
        supabase.from("customers").select("credit_balance").eq("store_id", storeId).eq("status", "approved"),
        supabase
          .from("products")
          .select("id", { count: "exact", head: true })
          .eq("store_id", storeId)
          .eq("is_active", true)
          .eq("is_low_stock", true),
        supabase.from("expenses").select("amount").eq("store_id", storeId).eq("expense_date", todayDate),
      ]);
      if (cancelled) return;

      if (salesRes.error) {
        setError(salesRes.error.message);
        setLoading(false);
        return;
      }

      const sales = salesRes.data ?? [];
      // Net of refunds — a refunded sale no longer counts as revenue today,
      // same "net" reading SUMA Web's cash-report uses.
      const totals: MethodTotals = { cash: 0, card: 0, credit: 0 };
      let revenue = 0;
      for (const s of sales) {
        const net = Number(s.total_amount) - Number(s.refunded_amount);
        revenue += net;
        if (s.payment_method === "cash") totals.cash += net;
        else if (s.payment_method === "card") totals.card += net;
        else if (s.payment_method === "credit") totals.credit += net;
      }
      setByMethod(totals);
      setTodayTotal(revenue);
      setTodayCount(sales.length);
      setTotalDebt((customersRes.data ?? []).reduce((sum, c) => sum + Number(c.credit_balance), 0));
      setLowStockCount(lowStockRes.count ?? 0);

      const saleIds = sales.map((s) => s.id);
      let items: { product_id: string | null; quantity: number; refunded_quantity: number; unit_price: number }[] = [];
      let products: { id: string; purchase_price: number | null }[] = [];
      if (saleIds.length > 0) {
        const { data: itemsData } = await supabase
          .from("sale_items")
          .select("product_id, quantity, refunded_quantity, unit_price")
          .in("sale_id", saleIds);
        items = itemsData ?? [];
        const productIds = Array.from(new Set(items.map((i) => i.product_id).filter((id): id is string => id !== null)));
        if (productIds.length > 0) {
          const { data: productsData } = await supabase.from("products").select("id, purchase_price").in("id", productIds);
          products = productsData ?? [];
        }
      }
      const { cost, margin, unknownCostRevenue } = computeProfit(sales, items, products);
      const expensesTotal = (expensesRes.data ?? []).reduce((sum, e) => sum + Number(e.amount), 0);
      setProfit({ revenue, cost, margin, expenses: expensesTotal, netProfit: margin - expensesTotal, unknownCostRevenue });

      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  if (loading) {
    return (
      <div className="grid min-h-[50vh] place-items-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }

  if (error) {
    return (
      <div className="surface p-6 text-center">
        <p className="text-sm text-destructive">تعذر تحميل الإحصائيات: {error}</p>
        <p className="mt-1 text-xs text-muted-foreground">الإحصائيات تحتاج اتصال بالإنترنت.</p>
      </div>
    );
  }

  const maxMethod = Math.max(byMethod.cash, byMethod.card, byMethod.credit, 1);
  const bars: Array<{ label: string; value: number; color: string }> = [
    { label: "نقدًا", value: byMethod.cash, color: "#2a78d6" },
    { label: "بطاقة", value: byMethod.card, color: "#eb6834" },
    { label: "كريدي", value: byMethod.credit, color: "#1baf7a" },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-black tracking-tight">الإحصائيات</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">نظرة سريعة على أداء المحل اليوم.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile icon={TrendingUp} label="مبيعات اليوم (صافي)" value={formatDA(todayTotal)} />
        <StatTile icon={Receipt} label="عدد العمليات اليوم" value={String(todayCount)} />
        <StatTile
          icon={profit.netProfit >= 0 ? Wallet : TrendingDown}
          label="صافي الربح التقديري اليوم"
          value={formatDA(profit.netProfit)}
          tone={profit.netProfit < 0 ? "bad" : undefined}
        />
        <StatTile icon={Users} label="ديون الزبائن الإجمالية" value={formatDA(totalDebt)} tone={totalDebt > 0 ? "warn" : undefined} />
        <StatTile icon={PackageX} label="منتجات منخفضة المخزون" value={String(lowStockCount)} tone={lowStockCount > 0 ? "warn" : undefined} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="surface p-4">
          <div className="mb-4 flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
              <BarChart3 className="size-4" aria-hidden />
            </span>
            <h2 className="text-sm font-bold">توزيع طرق الدفع اليوم</h2>
          </div>
          {todayTotal === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">لا توجد مبيعات اليوم بعد</p>
          ) : (
            <div className="space-y-3">
              {bars.map((b) => (
                <div key={b.label} className="flex items-center gap-3">
                  <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground">{b.label}</span>
                  <div className="h-5 flex-1 overflow-hidden rounded-full bg-[var(--muted)]">
                    <div
                      className="h-5 rounded-full transition-[width] duration-500 ease-out"
                      style={{
                        width: `${Math.max(2, (b.value / maxMethod) * 100)}%`,
                        backgroundColor: b.color,
                      }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-end text-xs font-bold num">{formatDA(b.value)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="surface p-4">
          <div className="mb-4 flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
              <Wallet className="size-4" aria-hidden />
            </span>
            <h2 className="text-sm font-bold">ملخص الأرباح والخسائر اليوم</h2>
          </div>
          <dl className="space-y-2 text-sm">
            <ProfitRow label="المبيعات (صافي المرتجعات)" value={profit.revenue} />
            <ProfitRow label="تكلفة البضاعة المباعة (تقديري)" value={-profit.cost} />
            <ProfitRow label="الهامش الإجمالي" value={profit.margin} bold />
            <ProfitRow label="المصاريف اليوم" value={-profit.expenses} />
            <div className="my-1 border-t border-border" />
            <ProfitRow label="صافي الربح" value={profit.netProfit} bold large />
          </dl>
          {profit.unknownCostRevenue > 0 && (
            <div className="mt-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2.5 text-[11px]">
              <p className="font-semibold text-[var(--warning-foreground)]">
                {formatDA(profit.unknownCostRevenue)} من المبيعات غير محتسبة ضمن الهامش أعلاه
              </p>
              <p className="mt-0.5 text-muted-foreground">
                أصناف بلا تكلفة معروفة (بيعت بزر "أخرى" بدون منتج، أو منتج بلا سعر شراء مسجَّل) — تكلفتها الحقيقية
                غير معروفة فلا نفترضها صفرًا ونعرضها كربح.
              </p>
            </div>
          )}
          <p className="mt-3 text-[11px] text-muted-foreground">
            تكلفة البضاعة تقديرية بناءً على آخر سعر شراء مسجَّل لكل منتج، وليس السعر وقت البيع فعليًا — نفس طريقة
            الحساب المعتمدة في «تقرير المحاسبة» على SUMA Web.
          </p>
        </div>
      </div>
    </div>
  );
}

function ProfitRow({ label, value, bold, large }: { label: string; value: number; bold?: boolean; large?: boolean }) {
  const negative = value < 0;
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className={`text-muted-foreground ${bold ? "font-semibold text-foreground" : ""}`}>{label}</dt>
      <dd
        className={`num ${bold ? "font-bold" : ""} ${large ? "text-lg" : ""} ${
          negative ? "text-destructive" : bold ? "text-[var(--primary)]" : ""
        }`}
      >
        {negative ? "−" : ""}
        {formatDA(Math.abs(value))}
      </dd>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof TrendingUp;
  label: string;
  value: string;
  tone?: "warn" | "bad";
}) {
  return (
    <div className="surface surface-interactive p-4">
      <span
        className={`grid size-9 place-items-center rounded-lg ${
          tone === "warn"
            ? "bg-[var(--warning)]/20 text-[var(--warning-foreground)]"
            : tone === "bad"
              ? "bg-[var(--destructive)]/10 text-destructive"
              : "bg-[var(--primary)]/10 text-[var(--primary)]"
        }`}
      >
        <Icon className="size-4.5" aria-hidden />
      </span>
      <div className="mt-2.5 text-xs text-muted-foreground">{label}</div>
      <div
        className={`text-2xl font-black num ${
          tone === "warn" ? "text-[var(--warning-foreground)]" : tone === "bad" ? "text-destructive" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}
