import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Power, Users, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useStore } from "@/context/StoreContext";
import type { StoreMemberRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type PermKey = "can_update_price" | "can_manage_products" | "can_print_labels" | "can_use_pos" | "can_refund" | "can_manage_customers";

const PERM_LABELS: Array<{ key: PermKey; label: string }> = [
  { key: "can_use_pos", label: "استعمال نقطة البيع" },
  { key: "can_refund", label: "تسجيل الإرجاعات" },
  { key: "can_manage_products", label: "إدارة المنتجات والمخزون" },
  { key: "can_update_price", label: "تعديل الأسعار" },
  { key: "can_print_labels", label: "طباعة الملصقات" },
  { key: "can_manage_customers", label: "إدارة الزبائن" },
];

type FormState = {
  full_name: string;
  phone: string;
  role: "manager" | "employee";
} & Record<PermKey, boolean>;

const EMPTY_FORM: FormState = {
  full_name: "",
  phone: "",
  role: "employee",
  can_update_price: false,
  can_manage_products: false,
  can_print_labels: false,
  can_use_pos: true,
  can_refund: false,
  can_manage_customers: false,
};

/**
 * Employee management (Phase A item 8) — plain CRUD over `store_members`,
 * same as SUMA Web (no dedicated RPC for this). Gated to `perms.isAdmin`
 * in the UI, but the real enforcement is server-side RLS: sm_admin_write/
 * sm_admin_update/sm_admin_delete all require is_store_admin(store_id)
 * (confirmed live via pg_policies) — a non-admin's insert/update/delete
 * is rejected by Postgres regardless of what this screen shows, not just
 * hidden client-side.
 *
 * "Add by phone" mirrors SUMA Web's own account-linking flow exactly: a
 * new row is inserted with `user_id = null` and a phone number; when
 * that phone's owner later signs in, AuthContext calls the existing
 * `link_my_employee_accounts()` RPC, which claims any unlinked
 * store_members row matching their profile's phone. Desktop has no way
 * to look up an existing user by phone up front (profiles is
 * self-select-only under RLS), so there's no separate "link existing
 * account" step here — it's the same one flow either way.
 */
export function EmployeesPage() {
  const { active } = useStore();
  const storeId = active!.id;

  const [members, setMembers] = useState<StoreMemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<StoreMemberRow | "new" | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const { data, error } = await supabase.from("store_members").select("*").eq("store_id", storeId).order("full_name");
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setMembers(data ?? []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  function openNew() {
    setForm(EMPTY_FORM);
    setEditing("new");
  }

  function openEdit(m: StoreMemberRow) {
    setForm({
      full_name: m.full_name ?? "",
      phone: m.phone ?? "",
      role: m.role,
      can_update_price: m.can_update_price,
      can_manage_products: m.can_manage_products,
      can_print_labels: m.can_print_labels,
      can_use_pos: m.can_use_pos,
      can_refund: m.can_refund,
      can_manage_customers: m.can_manage_customers,
    });
    setEditing(m);
  }

  async function save() {
    const phone = form.phone.trim();
    const fullName = form.full_name.trim();
    if (!phone) return toast.error("لازم رقم هاتف — يُستعمل لربط حساب الموظف عند تسجيل دخوله.");
    if (!fullName) return toast.error("لازم الاسم الكامل.");

    const payload = {
      full_name: fullName,
      phone,
      role: form.role,
      can_update_price: form.can_update_price,
      can_manage_products: form.can_manage_products,
      can_print_labels: form.can_print_labels,
      can_use_pos: form.can_use_pos,
      can_refund: form.can_refund,
      can_manage_customers: form.can_manage_customers,
    };

    setSaving(true);
    if (editing === "new") {
      const { error } = await supabase.from("store_members").insert({ ...payload, store_id: storeId, is_active: true });
      setSaving(false);
      if (error) return toast.error(mapMemberError(error.message));
      toast.success("تمت إضافة الموظف — سيُربط حسابه تلقائيًا عند تسجيل دخوله بنفس رقم الهاتف.");
    } else if (editing) {
      const { error } = await supabase.from("store_members").update(payload).eq("id", editing.id).eq("store_id", storeId);
      setSaving(false);
      if (error) return toast.error(mapMemberError(error.message));
      toast.success("تم تحديث بيانات الموظف.");
    }
    setEditing(null);
    void load();
  }

  async function toggleActive(m: StoreMemberRow) {
    setBusyId(m.id);
    const { error } = await supabase.from("store_members").update({ is_active: !m.is_active }).eq("id", m.id).eq("store_id", storeId);
    setBusyId(null);
    if (error) return toast.error(mapMemberError(error.message));
    toast.success(m.is_active ? "تم إيقاف الموظف." : "تم إعادة تفعيل الموظف.");
    void load();
  }

  return (
    <div className="space-y-3">
      <div className="surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
            <Users className="size-4" aria-hidden />
          </span>
          <h1 className="text-lg font-bold">الموظفون</h1>
          <Button size="sm" className="ms-auto" onClick={openNew}>
            <Plus className="size-3.5" aria-hidden />
            موظف جديد
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          صاحب المحل نفسه ليس ضمن هذه القائمة — صلاحياته كاملة تلقائيًا وتُدار من إعدادات الحساب على SUMA Web.
        </p>
      </div>

      <div className="surface overflow-hidden p-0">
        {loading ? (
          <div className="grid place-items-center py-10">
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : members.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">لا يوجد موظفون بعد.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
                <th className="px-3 py-2 text-start font-bold">الاسم</th>
                <th className="px-3 py-2 text-start font-bold">الهاتف</th>
                <th className="px-3 py-2 text-center font-bold">الدور</th>
                <th className="px-3 py-2 text-center font-bold">الحالة</th>
                <th className="px-3 py-2 text-center font-bold">مرتبط بحساب؟</th>
                <th className="w-28 px-3 py-2 text-center font-bold">إجراء</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m, i) => (
                <tr key={m.id} className={`border-b border-border last:border-0 ${i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"} ${!m.is_active ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2 font-medium">{m.full_name || "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground num" dir="ltr">{m.phone || "—"}</td>
                  <td className="px-3 py-2 text-center text-xs">{m.role === "manager" ? "مدير" : "موظف"}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${m.is_active ? "bg-[var(--success)]/15 text-[var(--success)]" : "bg-[var(--muted)] text-muted-foreground"}`}>
                      {m.is_active ? "نشط" : "موقوف"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-muted-foreground">{m.user_id ? "نعم" : "بانتظار أول تسجيل دخول"}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => openEdit(m)}>
                        <Pencil className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`size-7 ${m.is_active ? "text-destructive" : "text-[var(--success)]"}`}
                        disabled={busyId === m.id}
                        onClick={() => void toggleActive(m)}
                        title={m.is_active ? "إيقاف" : "إعادة تفعيل"}
                      >
                        {busyId === m.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Power className="size-3.5" aria-hidden />}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setEditing(null)}>
          <div className="surface w-full max-w-md p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="font-bold">{editing === "new" ? "موظف جديد" : "تعديل موظف"}</h2>
              <Button variant="ghost" size="icon" className="ms-auto" onClick={() => setEditing(null)}>
                <X className="size-4" aria-hidden />
              </Button>
            </div>

            <div className="space-y-2">
              <div>
                <Label htmlFor="emp-name">الاسم الكامل *</Label>
                <Input id="emp-name" value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))} />
              </div>
              <div>
                <Label htmlFor="emp-phone">رقم الهاتف *</Label>
                <Input id="emp-phone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} dir="ltr" placeholder="0555xxxxxx" />
              </div>
              <div>
                <Label htmlFor="emp-role">الدور</Label>
                <select
                  id="emp-role"
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as "manager" | "employee" }))}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="employee">موظف</option>
                  <option value="manager">مدير</option>
                </select>
                <p className="mt-1 text-[11px] text-muted-foreground">"مدير" يحصل تلقائيًا على كل الصلاحيات أدناه بغض النظر عن الأعلام.</p>
              </div>

              <div className="border-t border-border pt-2">
                <p className="mb-1.5 text-xs font-semibold text-muted-foreground">الصلاحيات (للموظف العادي)</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {PERM_LABELS.map(({ key, label }) => (
                    <label key={key} className="flex cursor-pointer items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={form[key]}
                        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
                        disabled={key === "can_update_price"}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  تعديل الأسعار متاح لصاحب المحل فقط حاليًا، بغض النظر عن هذا العلم.
                </p>
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
    </div>
  );
}

function mapMemberError(message: string): string {
  if (message.toLowerCase().includes("row-level security")) return "ما عندكش الصلاحية باش تدير هذا التغيير.";
  if (message.includes("duplicate") || message.includes("unique")) return "رقم الهاتف هذا مستعمل من قبل لموظف آخر في هذا المحل.";
  return message;
}
