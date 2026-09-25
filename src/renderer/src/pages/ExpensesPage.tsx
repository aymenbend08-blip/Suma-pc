import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Receipt, Trash2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useStore } from "@/context/StoreContext";
import { useAuth } from "@/context/AuthContext";
import { formatDA, formatDate } from "@/lib/format";
import type { ExpenseRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Expenses (Phase A item 7) — plain CRUD over the `expenses` table, which
 * already exists server-side (RLS: admin read+write, member read-only —
 * confirmed live via pg_policies, matches SUMA Web's own plain-table
 * expenses screen, no RPC). No `category` column exists on the real
 * schema and none is added here — free-text `description` only, per the
 * "minimal Supabase changes" rule. Never touches stock or sales in any
 * way; only feeds CashRegisterPage's report (item 6) via a read of this
 * same table keyed by `created_at`.
 */
export function ExpensesPage() {
  const { active } = useStore();
  const { session } = useAuth();
  const storeId = active!.id;

  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");

  const [editing, setEditing] = useState<ExpenseRow | "new" | null>(null);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [expenseDate, setExpenseDate] = useState(todayIso());
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ExpenseRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    setLoading(true);
    let query = supabase.from("expenses").select("*").eq("store_id", storeId).order("expense_date", { ascending: false }).order("created_at", { ascending: false });
    if (dateFrom) query = query.gte("expense_date", dateFrom);
    if (dateTo) query = query.lte("expense_date", dateTo);
    const { data, error } = await query.limit(500);
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setExpenses(data ?? []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, dateFrom, dateTo]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return expenses;
    return expenses.filter((e) => e.description.toLowerCase().includes(q));
  }, [expenses, search]);

  const total = filtered.reduce((sum, e) => sum + Number(e.amount), 0);

  function openNew() {
    setEditing("new");
    setAmount("");
    setDescription("");
    setExpenseDate(todayIso());
  }

  function openEdit(e: ExpenseRow) {
    setEditing(e);
    setAmount(String(e.amount));
    setDescription(e.description);
    setExpenseDate(e.expense_date);
  }

  async function save() {
    const value = Number(amount);
    if (!(value > 0)) return toast.error("المبلغ لازم يكون أكبر من صفر.");
    const desc = description.trim();
    if (!desc) return toast.error("لازم وصف للمصروف.");
    if (!expenseDate) return toast.error("لازم تاريخ.");

    setSaving(true);
    if (editing === "new") {
      const { error } = await supabase.from("expenses").insert({
        store_id: storeId,
        amount: value,
        description: desc,
        expense_date: expenseDate,
        created_by: session?.user.id ?? null,
      });
      setSaving(false);
      if (error) return toast.error(mapExpenseError(error.message));
      toast.success("تمت إضافة المصروف.");
    } else if (editing) {
      const { error } = await supabase
        .from("expenses")
        .update({ amount: value, description: desc, expense_date: expenseDate })
        .eq("id", editing.id)
        .eq("store_id", storeId);
      setSaving(false);
      if (error) return toast.error(mapExpenseError(error.message));
      toast.success("تم تحديث المصروف.");
    }
    setEditing(null);
    void load();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase.from("expenses").delete().eq("id", deleteTarget.id).eq("store_id", storeId);
    setDeleting(false);
    if (error) {
      toast.error(mapExpenseError(error.message));
      return;
    }
    toast.success("تم حذف المصروف.");
    setDeleteTarget(null);
    void load();
  }

  return (
    <div className="space-y-3">
      <div className="surface p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
            <Receipt className="size-4" aria-hidden />
          </span>
          <h1 className="text-lg font-bold">المصاريف</h1>
          <Button size="sm" className="ms-auto" onClick={openNew}>
            <Plus className="size-3.5" aria-hidden />
            مصروف جديد
          </Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} placeholder="من تاريخ" />
          <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} placeholder="إلى تاريخ" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث في الوصف..." />
        </div>
      </div>

      <div className="surface overflow-hidden p-0">
        {loading ? (
          <div className="grid place-items-center py-10">
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">لا توجد مصاريف مطابقة.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
                <th className="px-3 py-2 text-start font-bold">التاريخ</th>
                <th className="px-3 py-2 text-start font-bold">الوصف</th>
                <th className="px-3 py-2 text-center font-bold">المبلغ</th>
                <th className="w-24 px-3 py-2 text-center font-bold">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr key={e.id} className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"}`}>
                  <td className="px-3 py-2 text-xs text-muted-foreground num" dir="ltr">{formatDate(e.expense_date)}</td>
                  <td className="px-3 py-2">{e.description}</td>
                  <td className="px-3 py-2 text-center font-bold num">{formatDA(e.amount)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => openEdit(e)}>
                        <Pencil className="size-3.5" aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7 text-destructive" onClick={() => setDeleteTarget(e)}>
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border font-bold">
                <td className="px-3 py-2" colSpan={2}>الإجمالي</td>
                <td className="px-3 py-2 text-center num">{formatDA(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setEditing(null)}>
          <div className="surface w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="font-bold">{editing === "new" ? "مصروف جديد" : "تعديل مصروف"}</h2>
              <Button variant="ghost" size="icon" className="ms-auto" onClick={() => setEditing(null)}>
                <X className="size-4" aria-hidden />
              </Button>
            </div>
            <div className="space-y-2">
              <div>
                <Label htmlFor="exp-amount">المبلغ (دج) *</Label>
                <Input id="exp-amount" type="number" min={0} autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="exp-desc">الوصف *</Label>
                <Input id="exp-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="كهرباء، إيجار، نقل..." />
              </div>
              <div>
                <Label htmlFor="exp-date">التاريخ *</Label>
                <Input id="exp-date" type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setEditing(null)}>إلغاء</Button>
              <Button className="flex-1" disabled={saving} onClick={() => void save()}>
                {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
                حفظ
              </Button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setDeleteTarget(null)}>
          <div className="surface w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 font-bold">تأكيد الحذف</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              هل تريد حذف مصروف "{deleteTarget.description}" بقيمة {formatDA(deleteTarget.amount)}؟ لا يمكن التراجع عن هذا الإجراء.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setDeleteTarget(null)}>إلغاء</Button>
              <Button variant="destructive" className="flex-1" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting && <Loader2 className="size-4 animate-spin" aria-hidden />}
                حذف
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function mapExpenseError(message: string): string {
  if (message.toLowerCase().includes("row-level security")) return "ما عندكش الصلاحية باش تدير هذا التغيير.";
  return message;
}
