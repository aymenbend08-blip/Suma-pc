import { useEffect, useState } from "react";
import { CalendarDays, CloudOff, Pencil, Phone, Star, Wallet, X } from "lucide-react";
import { useStore } from "@/context/StoreContext";
import { formatDA, formatDate } from "@/lib/format";
import { customerCreditState, isCustomerOverdue } from "@/lib/customerList";
import { availablePointsModes } from "@/lib/customerPoints";
import type { CustomerRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { CustomerAvatar } from "./shared";
import { CustomerStatementTab, type StatementPrintJob } from "./CustomerStatementTab";
import { CustomerPointsLedgerTab } from "./CustomerPointsLedgerTab";
import { CustomerStatementPrint } from "./CustomerStatementPrint";

const STATUS_LABEL: Record<CustomerRow["status"], { label: string; tone: string }> = {
  approved: { label: "مؤكَّد", tone: "bg-[var(--success)]/15 text-[var(--success)]" },
  pending: { label: "قيد التأكيد", tone: "bg-[var(--warning)]/20 text-[var(--warning-foreground)]" },
  rejected: { label: "مرفوض", tone: "bg-[var(--destructive)]/10 text-destructive" },
};

/**
 * ملف الزبون — header (identity, balance semantics, points) + quick
 * actions, and two online-only tabs: the statement and the points ledger.
 * Dialogs (pay / edit / points) are owned by the page so the list row and
 * this header update from the same result.
 */
export function CustomerProfile({
  customer,
  storeId,
  isOnline,
  overdueDays,
  reloadKey,
  onClose,
  onPay,
  onEdit,
  onPoints,
  onCustomerRefreshed,
}: {
  customer: CustomerRow;
  storeId: string;
  isOnline: boolean;
  overdueDays: number;
  /** Bumped by the page after a payment/points change to refetch tabs. */
  reloadKey: number;
  onClose: () => void;
  onPay: () => void;
  onEdit: () => void;
  onPoints: () => void;
  onCustomerRefreshed: (row: CustomerRow) => void;
}) {
  const { active, perms } = useStore();
  const [tab, setTab] = useState("statement");
  const [printJob, setPrintJob] = useState<StatementPrintJob | null>(null);

  const credit = customerCreditState(customer.credit_balance);
  const overdue = isCustomerOverdue(customer, overdueDays);
  const canPoints = availablePointsModes(perms).length > 0;
  const status = STATUS_LABEL[customer.status];

  // Print once the print-only layout for this job has rendered.
  useEffect(() => {
    if (!printJob) return;
    const t = window.setTimeout(() => window.print(), 50);
    return () => window.clearTimeout(t);
  }, [printJob]);

  return (
    <>
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4 print:hidden" onClick={onClose}>
        <div
          className="surface flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden p-0"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label={`ملف الزبون ${customer.full_name}`}
        >
          <header className="flex flex-wrap items-start gap-4 border-b border-border p-4">
            <CustomerAvatar name={customer.full_name} size="lg" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-lg font-bold">{customer.full_name}</h2>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", status.tone)}>{status.label}</span>
              </div>
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Phone className="size-3.5" aria-hidden />
                  <span className="num" dir="ltr">
                    {customer.phone}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="size-3.5" aria-hidden />
                  زبون منذ {formatDate(customer.approved_at ?? customer.created_at)}
                </span>
              </p>
            </div>

            <div className="flex items-stretch gap-2">
              <div
                className={cn(
                  "min-w-36 rounded-lg border p-2.5",
                  credit.kind === "debt"
                    ? overdue
                      ? "border-[var(--destructive)] bg-[var(--destructive)]/10"
                      : "border-[var(--destructive)]/30 bg-[var(--destructive)]/5"
                    : credit.kind === "credit"
                      ? "border-[var(--success)]/40 bg-[var(--success)]/10"
                      : "border-border bg-background",
                )}
              >
                <p className="text-[11px] text-muted-foreground">الرصيد</p>
                <p
                  className={cn(
                    "text-base font-black",
                    credit.kind === "debt" ? "text-destructive" : credit.kind === "credit" ? "text-[var(--success)]" : "",
                  )}
                >
                  {credit.kind === "none" ? (
                    "لا يوجد دّين"
                  ) : (
                    <>
                      {credit.kind === "debt" ? "عليه " : "له "}
                      <span className="num">{formatDA(credit.amount)}</span>
                    </>
                  )}
                </p>
                {credit.kind === "debt" && overdue && (
                  <p className="text-[10px] font-bold text-destructive">
                    دّين طويل — منذ {formatDate(customer.credit_since)}
                  </p>
                )}
                {credit.kind === "debt" && !overdue && customer.credit_since && (
                  <p className="text-[10px] text-muted-foreground">منذ {formatDate(customer.credit_since)}</p>
                )}
              </div>
              <div className="min-w-24 rounded-lg border border-border bg-background p-2.5">
                <p className="text-[11px] text-muted-foreground">النقاط</p>
                <p className="flex items-center gap-1 text-base font-black">
                  <Star className="size-4 text-[var(--accent)]" aria-hidden />
                  <span className="num">{Number(customer.points_balance)}</span>
                </p>
              </div>
            </div>

            <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="إغلاق">
              <X className="size-4" aria-hidden />
            </Button>
          </header>

          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            {credit.kind === "debt" && (
              <Button size="sm" onClick={onPay}>
                <Wallet className="size-3.5" aria-hidden />
                تسديد
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={!isOnline}
              title={!isOnline ? "يحتاج اتصالاً بالإنترنت" : undefined}
              onClick={onEdit}
            >
              <Pencil className="size-3.5" aria-hidden />
              تعديل
            </Button>
            {canPoints && (
              <Button
                size="sm"
                variant="outline"
                disabled={!isOnline}
                title={!isOnline ? "يحتاج اتصالاً بالإنترنت" : undefined}
                onClick={onPoints}
              >
                <Star className="size-3.5" aria-hidden />
                نقاط
              </Button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {!isOnline ? (
              <div className="surface flex items-center gap-2 border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4 text-sm">
                <CloudOff className="size-4 shrink-0 text-[var(--warning-foreground)]" aria-hidden />
                كشف الحساب وسجل النقاط يحتاجان اتصالاً بالإنترنت. التسديد يبقى متاحًا ويُزامَن تلقائيًا.
              </div>
            ) : (
              <Tabs value={tab} onValueChange={setTab} dir="rtl">
                <TabsList>
                  <TabsTrigger value="statement">كشف الحساب</TabsTrigger>
                  <TabsTrigger value="points">سجل النقاط</TabsTrigger>
                </TabsList>
                {/* Kept mounted so filters/page survive a switch to the points tab. */}
                <TabsContent value="statement" forceMount className="data-[state=inactive]:hidden">
                  <CustomerStatementTab
                    customer={customer}
                    storeId={storeId}
                    reloadKey={reloadKey}
                    onCustomerRefreshed={onCustomerRefreshed}
                    onPrint={setPrintJob}
                  />
                </TabsContent>
                <TabsContent value="points">
                  <CustomerPointsLedgerTab customerId={customer.id} storeId={storeId} reloadKey={reloadKey} />
                </TabsContent>
              </Tabs>
            )}
          </div>
        </div>
      </div>

      {printJob && active && <CustomerStatementPrint job={printJob} store={active} customer={customer} />}
    </>
  );
}
