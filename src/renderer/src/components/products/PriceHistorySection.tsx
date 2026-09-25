import { useEffect, useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatDA, formatDateTime } from "@/lib/format";
import type { PriceHistoryRow } from "@/lib/database.types";

const SOURCE_LABEL: Record<string, string> = {
  manual: "يدوي",
  connector: "ربط خارجي",
  import: "استيراد",
  system: "النظام",
};

const LIMIT = 20;

/**
 * Last 20 selling-price changes of one product (price_history is written by
 * a database trigger on every price change, whatever client made it, and is
 * readable by every store member). Fiche Produit closes on save, so a
 * fresh open always shows the latest change.
 */
export function PriceHistorySection({ productId }: { productId: string }) {
  const [rows, setRows] = useState<PriceHistoryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from("price_history")
      .select("*")
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .limit(LIMIT)
      .then(({ data, error }) => {
        if (cancelled) return;
        setFailed(Boolean(error));
        setRows(data ?? []);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  return (
    <section className="surface overflow-hidden p-0">
      <h2 className="bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">سجل الأسعار</h2>
      <div className="p-4">
        {!loaded ? (
          <p className="text-xs text-muted-foreground">جاري التحميل...</p>
        ) : failed ? (
          <p className="text-xs text-muted-foreground">تعذّر تحميل سجل الأسعار (يحتاج اتصالاً بالإنترنت).</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">ما تبدّلش سعر هذا المنتج بعد.</p>
        ) : (
          <ul className="grid max-h-56 gap-1.5 overflow-y-auto">
            {rows.map((r) => {
              const up = r.old_price !== null && Number(r.new_price) > Number(r.old_price);
              const down = r.old_price !== null && Number(r.new_price) < Number(r.old_price);
              return (
                <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1 num">
                    {up && <TrendingUp className="size-3.5 text-destructive" aria-hidden />}
                    {down && <TrendingDown className="size-3.5 text-[var(--success)]" aria-hidden />}
                    {r.old_price === null ? "—" : formatDA(r.old_price)} ← <span className="font-bold">{formatDA(r.new_price)}</span>
                  </span>
                  <span className="shrink-0 rounded-full bg-[var(--muted)] px-2 py-0.5 font-semibold">{SOURCE_LABEL[r.source] ?? r.source}</span>
                  <span className="shrink-0 text-muted-foreground">{formatDateTime(r.created_at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
