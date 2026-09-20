import { useEffect, useState } from "react";
import { BarChart3, Loader2, TrendingUp, Users, PackageX, Receipt } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useStore } from "@/context/StoreContext";
import { formatDA } from "@/lib/format";

type MethodTotals = { cash: number; card: number; credit: number };

/**
 * Real numbers, straight from Supabase (the same authenticated, RLS-scoped
 * client every other screen uses) — no local SQLite fallback, since this is
 * an owner-facing rollup that should never silently show a stale offline
 * snapshot as if it were current. Deliberately a first cut (today's sales,
 * payment-method split, outstanding credit, low stock) — more views
 * (trends, top products, date ranges) are meant to build on this later.
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const [salesRes, customersRes, lowStockRes] = await Promise.all([
        supabase
          .from("sales")
          .select("total_amount, payment_method")
          .eq("store_id", storeId)
          .gte("created_at", startOfDay.toISOString()),
        supabase.from("customers").select("credit_balance").eq("store_id", storeId).eq("status", "approved"),
        supabase
          .from("products")
          .select("id", { count: "exact", head: true })
          .eq("store_id", storeId)
          .eq("is_active", true)
          .eq("is_low_stock", true),
      ]);
      if (cancelled) return;

      if (salesRes.error) {
        setError(salesRes.error.message);
        setLoading(false);
        return;
      }

      const sales = salesRes.data ?? [];
      const totals: MethodTotals = { cash: 0, card: 0, credit: 0 };
      for (const s of sales) {
        const amount = Number(s.total_amount);
        if (s.payment_method === "cash") totals.cash += amount;
        else if (s.payment_method === "card") totals.card += amount;
        else if (s.payment_method === "credit") totals.credit += amount;
      }
      setByMethod(totals);
      setTodayTotal(totals.cash + totals.card + totals.credit);
      setTodayCount(sales.length);
      setTotalDebt((customersRes.data ?? []).reduce((sum, c) => sum + Number(c.credit_balance), 0));
      setLowStockCount(lowStockRes.count ?? 0);
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile icon={TrendingUp} label="مبيعات اليوم" value={formatDA(todayTotal)} />
        <StatTile icon={Receipt} label="عدد العمليات اليوم" value={String(todayCount)} />
        <StatTile icon={Users} label="ديون الزبائن الإجمالية" value={formatDA(totalDebt)} tone={totalDebt > 0 ? "warn" : undefined} />
        <StatTile icon={PackageX} label="منتجات منخفضة المخزون" value={String(lowStockCount)} tone={lowStockCount > 0 ? "warn" : undefined} />
      </div>

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
  tone?: "warn";
}) {
  return (
    <div className="surface surface-interactive p-4">
      <span
        className={`grid size-9 place-items-center rounded-lg ${
          tone === "warn" ? "bg-[var(--warning)]/20 text-[var(--warning-foreground)]" : "bg-[var(--primary)]/10 text-[var(--primary)]"
        }`}
      >
        <Icon className="size-4.5" aria-hidden />
      </span>
      <div className="mt-2.5 text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-black num ${tone === "warn" ? "text-[var(--warning-foreground)]" : ""}`}>{value}</div>
    </div>
  );
}
