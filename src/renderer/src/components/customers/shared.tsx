import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, Loader2, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDA } from "@/lib/format";
import { customerCreditState, customerInitials, isCustomerOverdue, pageCount, pageSummary } from "@/lib/customerList";
import { cn } from "@/lib/utils";

/** Same overlay + `surface` panel pattern as the rest of SUMA PC. Hidden
 * when printing so only a page's print-only layout reaches the paper. */
export function CustomerModal({
  title,
  onClose,
  children,
  className,
  zIndex = "z-50",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  zIndex?: "z-50" | "z-[60]";
}) {
  return (
    <div className={cn("fixed inset-0 grid place-items-center bg-black/40 p-4 print:hidden", zIndex)} onClick={onClose}>
      <div className={cn("surface w-full max-w-sm p-4", className)} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="font-bold">{title}</h2>
          <Button variant="ghost" size="icon" className="ms-auto size-7" onClick={onClose} aria-label="إغلاق">
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CustomerAvatar({ name, size = "sm" }: { name: string; size?: "sm" | "lg" }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-[var(--primary)]/10 font-bold text-[var(--primary)]",
        size === "lg" ? "size-12 text-base" : "size-8 text-[11px]",
      )}
    >
      {customerInitials(name)}
    </span>
  );
}

export function PointsBadge({ points }: { points: number | string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/20 px-2 py-0.5 text-[11px] font-bold text-[var(--accent-foreground)]">
      <Star className="size-3" aria-hidden />
      <span className="num">{Number(points)}</span>
    </span>
  );
}

/** Debt / long debt (overdue) / credit-for-customer — SUMA Web's three
 * balance semantics, one badge at most. */
export function CreditBadge({
  balance,
  creditSince,
  overdueDays,
}: {
  balance: number | string;
  creditSince: string | null;
  overdueDays: number;
}) {
  const state = customerCreditState(balance);
  if (state.kind === "none") return null;
  if (state.kind === "credit") {
    return (
      <span
        className="rounded-full bg-[var(--success)]/15 px-2 py-0.5 text-[11px] font-bold text-[var(--success)]"
        title="دفع أكثر مما عليه — المحل مدين له بهذا المبلغ"
      >
        رصيد له <span className="num">{formatDA(state.amount)}</span>
      </span>
    );
  }
  const overdue = isCustomerOverdue({ credit_balance: balance, credit_since: creditSince }, overdueDays);
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-bold",
        overdue ? "bg-[var(--destructive)] text-[var(--destructive-foreground)]" : "bg-[var(--destructive)]/10 text-destructive",
      )}
      title={overdue ? `دّين عمره ${overdueDays} يوم أو أكثر` : undefined}
    >
      {overdue ? "دّين طويل" : "دّين"} <span className="num">{formatDA(state.amount)}</span>
    </span>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
  disabled,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  disabled?: boolean;
}) {
  const pages = pageCount(total, pageSize);
  return (
    <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground print:hidden">
      <span className="num">{pageSummary(page, pageSize, total)}</span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          className="size-7"
          disabled={disabled || page === 0}
          onClick={() => onPage(Math.max(0, page - 1))}
          aria-label="الصفحة السابقة"
        >
          <ChevronRight className="size-3.5" aria-hidden />
        </Button>
        <span className="num">
          {page + 1} / {pages}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="size-7"
          disabled={disabled || page + 1 >= pages}
          onClick={() => onPage(page + 1)}
          aria-label="الصفحة التالية"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

export function LoadingRows() {
  return (
    <div className="grid place-items-center py-10">
      <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
    </div>
  );
}
