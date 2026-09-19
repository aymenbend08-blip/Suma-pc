import {
  BarChart3,
  RefreshCw,
  RotateCcw,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
} from "lucide-react";
import { useStore } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";
import type { Navigate } from "@/components/Shell";

type Tile = {
  key: string;
  label: string;
  icon: typeof ShoppingCart;
  visible: boolean;
  badge?: number;
  onClick: () => void;
};

/**
 * The landing screen after login — a menu of shortcuts to every section of
 * the program, reordered/recolored from the shop's reference register
 * software (ZN Stock) into SUMA's own palette. Tiles for features that
 * don't exist on Desktop yet (Suppliers, Purchases, Settings) are real,
 * separate screens that say so plainly (ComingSoonPage) rather than dead
 * buttons or a faked flow.
 */
export function HomePage({ onNavigate }: { onNavigate: Navigate }) {
  const { active, perms } = useStore();
  const { failedCount } = useSync();

  const tiles: Tile[] = [
    {
      key: "pos",
      label: "نقطة البيع",
      icon: ShoppingCart,
      visible: perms.canUsePos,
      onClick: () => onNavigate("pos"),
    },
    {
      key: "customers",
      label: "الزبائن",
      icon: Users,
      visible: perms.canManageCustomers,
      onClick: () => onNavigate("customers"),
    },
    {
      key: "customers-debt",
      label: "تسديد ديون الزبائن",
      icon: Wallet,
      visible: perms.canManageCustomers,
      onClick: () => onNavigate("customers", { debtOnly: true }),
    },
    {
      key: "pos-return",
      label: "إرجاع من زبون",
      icon: RotateCcw,
      visible: perms.canUsePos && perms.canRefund,
      onClick: () => onNavigate("pos", { autoOpenReturn: true }),
    },
    {
      key: "dashboard",
      label: "الإحصائيات",
      icon: BarChart3,
      visible: perms.isAdmin,
      onClick: () => onNavigate("dashboard"),
    },
    {
      key: "sync",
      label: "متابعة المزامنة",
      icon: RefreshCw,
      visible: perms.isAdmin,
      badge: failedCount,
      onClick: () => onNavigate("sync"),
    },
    {
      key: "suppliers",
      label: "الموردون",
      icon: Truck,
      visible: perms.isAdmin,
      onClick: () => onNavigate("coming-soon", { comingSoonTitle: "الموردون" }),
    },
    {
      key: "purchases",
      label: "المشتريات",
      icon: ShoppingBag,
      visible: perms.isAdmin,
      onClick: () => onNavigate("coming-soon", { comingSoonTitle: "المشتريات" }),
    },
    {
      key: "settings",
      label: "الإعدادات",
      icon: Settings,
      visible: perms.isAdmin,
      onClick: () => onNavigate("coming-soon", { comingSoonTitle: "الإعدادات" }),
    },
  ];

  const visibleTiles = tiles.filter((t) => t.visible);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-black">مرحبًا بك في {active?.store_name}</h1>
        <p className="text-sm text-muted-foreground">اختر من أين تريد أن تبدأ.</p>
      </div>

      {visibleTiles.length === 0 ? (
        <p className="surface p-6 text-center text-sm text-muted-foreground">
          ما عندكش صلاحية استعمال أي قسم في هذا المحل.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {visibleTiles.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={t.onClick}
              className="surface relative flex flex-col items-center gap-2 p-5 text-center transition-colors hover:bg-accent/10"
            >
              {!!t.badge && t.badge > 0 && (
                <span className="absolute end-3 top-3 rounded-full bg-[var(--destructive)] px-1.5 text-[10px] font-bold text-white num">
                  {t.badge}
                </span>
              )}
              <t.icon className="size-7 text-[var(--primary)]" aria-hidden />
              <span className="text-sm font-medium">{t.label}</span>
            </button>
          ))}
        </div>
      )}

      <MiniCalendar />
    </div>
  );
}

function MiniCalendar() {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthName = today.toLocaleDateString("ar-DZ", { month: "long", year: "numeric" });
  const weekDays = ["أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"];

  const cells: Array<number | null> = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="surface max-w-xs p-4">
      <h2 className="mb-2 text-center text-sm font-bold">{monthName}</h2>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
        {weekDays.map((d) => (
          <span key={d}>{d[0]}</span>
        ))}
        {cells.map((day, i) => (
          <span
            key={i}
            className={`rounded-full py-1 num ${
              day === today.getDate()
                ? "bg-[var(--primary)] font-bold text-[var(--primary-foreground)]"
                : day
                  ? "text-foreground"
                  : ""
            }`}
          >
            {day ?? ""}
          </span>
        ))}
      </div>
    </div>
  );
}
