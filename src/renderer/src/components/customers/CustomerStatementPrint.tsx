import { formatDA, formatDate, formatDateTime } from "@/lib/format";
import { hasBalanceDrift, shortRef, STATEMENT_KIND_LABEL, toChronological } from "@/lib/customerStatement";
import type { CustomerRow, StoreRow } from "@/lib/database.types";
import type { StatementPrintJob } from "./CustomerStatementTab";

function money(n: number): string {
  return n ? formatDA(n) : "—";
}

/**
 * Print-only A4 layout of the currently filtered statement (hidden on
 * screen, `print:block` on paper) — same window.print() approach SUMA Web
 * uses. Rendered OUTSIDE the profile modal (which is print:hidden) so the
 * page flow, not a fixed overlay, drives pagination across sheets.
 */
export function CustomerStatementPrint({
  job,
  store,
  customer,
}: {
  job: StatementPrintJob;
  store: StoreRow;
  customer: CustomerRow;
}) {
  const period =
    job.fromDate || job.toDate
      ? `${job.fromDate ? formatDate(`${job.fromDate}T00:00:00`) : "البداية"} — ${job.toDate ? formatDate(`${job.toDate}T00:00:00`) : "اليوم"}`
      : "كل الفترات";
  const kindsLabel = job.kinds.length > 0 ? job.kinds.map((k) => STATEMENT_KIND_LABEL[k]).join("، ") : "كل العمليات";
  const rows = toChronological(job.rows);

  return (
    <div dir="rtl" className="hidden text-[11px] leading-relaxed text-black print:block">
      <style>{"@page { size: A4; margin: 12mm; }"}</style>

      <header className="mb-3 flex items-start justify-between gap-4 border-b-2 border-black pb-2">
        <div>
          <p className="text-base font-black">{store.store_name}</p>
          {store.phone && (
            <p className="num" dir="ltr">
              {store.phone}
            </p>
          )}
          {(store.address || store.commune || store.wilaya) && (
            <p>{[store.address, store.commune, store.wilaya].filter(Boolean).join("، ")}</p>
          )}
        </div>
        <div className="text-end">
          <p className="text-base font-black">كشف حساب زبون</p>
          <p>طُبع في: {formatDateTime(job.printedAt)}</p>
        </div>
      </header>

      <section className="mb-3 grid grid-cols-2 gap-x-6 gap-y-0.5">
        <p>
          الزبون: <span className="font-bold">{customer.full_name}</span>
        </p>
        <p>
          الهاتف:{" "}
          <span className="num" dir="ltr">
            {customer.phone}
          </span>
        </p>
        <p>الفترة: {period}</p>
        <p>العمليات: {kindsLabel}</p>
        {job.search && (
          <p>
            بحث: <span className="num">{job.search}</span>
          </p>
        )}
      </section>

      <table className="mb-3 w-full border-collapse">
        <tbody>
          <tr>
            {[
              ["رصيد افتتاحي", job.openingBalance],
              ["مدين الفترة", job.periodDebit],
              ["دائن الفترة", job.periodCredit],
              ["رصيد ختامي", job.closingBalance],
            ].map(([label, value]) => (
              <td key={label as string} className="border border-black px-2 py-1 text-center">
                <p>{label}</p>
                <p className="font-bold num">{formatDA(value as number)}</p>
              </td>
            ))}
          </tr>
        </tbody>
      </table>

      {hasBalanceDrift(job.computedBalance, job.recordedBalance) && (
        <p className="mb-2 border border-black px-2 py-1 font-bold">
          تنبيه: الرصيد المسجّل ({formatDA(job.recordedBalance)}) لا يطابق مجموع العمليات ({formatDA(job.computedBalance)}).
        </p>
      )}

      <table className="w-full border-collapse">
        <thead className="table-header-group">
          <tr>
            {["التاريخ", "النوع", "المرجع", "المبلغ", "مدين", "دائن", "الرصيد"].map((h) => (
              <th key={h} className="border border-black bg-neutral-200 px-1.5 py-1 text-start font-bold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="break-inside-avoid">
            <td className="border border-black px-1.5 py-0.5" colSpan={6}>
              رصيد افتتاحي
            </td>
            <td className="border border-black px-1.5 py-0.5 font-bold num">{formatDA(job.openingBalance)}</td>
          </tr>
          {rows.map((r, i) => (
            <tr key={`${i}-${r.reference_id}-${r.kind}`} className="break-inside-avoid">
              <td className="border border-black px-1.5 py-0.5">{formatDateTime(r.occurred_at)}</td>
              <td className="border border-black px-1.5 py-0.5">{STATEMENT_KIND_LABEL[r.kind] ?? r.kind}</td>
              <td className="border border-black px-1.5 py-0.5 font-mono num" dir="ltr">
                {shortRef(r.reference_id)}
              </td>
              <td className="border border-black px-1.5 py-0.5 num">{formatDA(r.amount)}</td>
              <td className="border border-black px-1.5 py-0.5 num">{money(Number(r.debit))}</td>
              <td className="border border-black px-1.5 py-0.5 num">{money(Number(r.credit))}</td>
              <td className="border border-black px-1.5 py-0.5 font-bold num">{formatDA(r.balance_after)}</td>
            </tr>
          ))}
          <tr className="break-inside-avoid">
            <td className="border border-black px-1.5 py-0.5 font-bold" colSpan={6}>
              رصيد ختامي
            </td>
            <td className="border border-black px-1.5 py-0.5 font-black num">{formatDA(job.closingBalance)}</td>
          </tr>
        </tbody>
      </table>

      <p className="mt-2">
        عدد العمليات: <span className="num">{job.rows.length}</span>
        {job.truncated && (
          <>
            {" "}
            (من أصل <span className="num">{job.total}</span> — ضيّق الفترة لطباعة الباقي)
          </>
        )}
      </p>
      <p className="mt-6 text-center text-[10px]">SUMA</p>
    </div>
  );
}
