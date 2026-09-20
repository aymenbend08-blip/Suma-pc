import { type ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Boxes,
  CloudOff,
  Home,
  Menu,
  Minus,
  Package,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Truck,
  User,
  Users,
  Wallet,
  Wifi,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useStore, type StorePermissions } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";

export type Page = "home" | "pos" | "products" | "customers" | "dashboard" | "sync" | "coming-soon";

export type NavOptions = { autoOpenReturn?: boolean; debtOnly?: boolean; comingSoonTitle?: string };
export type Navigate = (page: Page, opts?: NavOptions) => void;

type SidebarSection = {
  key: string;
  label: string;
  icon: typeof Home;
  visible: (perms: StorePermissions) => boolean;
  page: Page;
  opts?: NavOptions;
  badge?: number;
};

/**
 * Sidebar section order/labels/icons mirror the shop's own reference
 * register software 1:1 (Accueil/Vente/Articles/Stock/Achats/Clients/
 * Fournisseurs/Statistiques/Caisse/Retours/Paramètres) — only the active
 * color and overall visual language changed, per explicit sign-off to keep
 * the structure and only restyle it. "متابعة المزامنة" has no equivalent
 * in that reference at all, so it's appended after Paramètres rather than
 * dropped — it's a real, already-shipped Desktop feature.
 *
 * Sections with no Desktop feature behind them yet (Articles, Stock,
 * Achats, Fournisseurs, Caisse, Paramètres) route to the existing
 * ComingSoonPage via the "coming-soon" page + a title, same pattern
 * HomePage's own placeholder tiles already used — nothing new invented,
 * just reachable from a second place now.
 */
function buildSections(failedCount: number): SidebarSection[] {
  return [
    { key: "home", label: "الرئيسية", icon: Home, visible: () => true, page: "home" },
    {
      key: "pos",
      label: "البيع",
      icon: ShoppingCart,
      visible: (p) => p.canUsePos,
      page: "pos",
    },
    {
      key: "articles",
      label: "المنتجات",
      icon: Package,
      visible: (p) => p.canManageProducts,
      page: "products",
    },
    {
      key: "stock",
      label: "المخزون",
      icon: Boxes,
      visible: (p) => p.isAdmin,
      page: "coming-soon",
      opts: { comingSoonTitle: "المخزون" },
    },
    {
      key: "achats",
      label: "المشتريات",
      icon: ShoppingBag,
      visible: (p) => p.isAdmin,
      page: "coming-soon",
      opts: { comingSoonTitle: "المشتريات" },
    },
    {
      key: "clients",
      label: "العملاء",
      icon: Users,
      visible: (p) => p.canManageCustomers,
      page: "customers",
    },
    {
      key: "fournisseurs",
      label: "الموردون",
      icon: Truck,
      visible: (p) => p.isAdmin,
      page: "coming-soon",
      opts: { comingSoonTitle: "الموردون" },
    },
    {
      key: "statistiques",
      label: "الإحصائيات",
      icon: BarChart3,
      visible: (p) => p.isAdmin,
      page: "dashboard",
    },
    {
      key: "caisse",
      label: "الصندوق",
      icon: Wallet,
      visible: (p) => p.isAdmin,
      page: "coming-soon",
      opts: { comingSoonTitle: "الصندوق" },
    },
    {
      key: "retours",
      label: "المرتجعات",
      icon: RotateCcw,
      visible: (p) => p.canUsePos && p.canRefund,
      page: "pos",
      opts: { autoOpenReturn: true },
    },
    {
      key: "parametres",
      label: "الإعدادات",
      icon: Settings,
      visible: (p) => p.isAdmin,
      page: "coming-soon",
      opts: { comingSoonTitle: "الإعدادات" },
    },
    {
      key: "sync",
      label: "متابعة المزامنة",
      icon: RefreshCw,
      visible: (p) => p.isAdmin,
      page: "sync",
      badge: failedCount,
    },
  ];
}

/** Matches a sidebar entry to the page currently on screen — "retours" and
 * "pos" both render POSPage, so it keys off page + the one opt that tells
 * them apart, not page alone. */
function isActive(section: SidebarSection, page: Page, opts: NavOptions): boolean {
  if (section.page !== page) return false;
  if (page === "pos") return Boolean(section.opts?.autoOpenReturn) === Boolean(opts.autoOpenReturn);
  if (page === "coming-soon") return section.opts?.comingSoonTitle === opts.comingSoonTitle;
  return true;
}

export function Shell({
  page,
  navOpts,
  onNavigate,
  children,
}: {
  page: Page;
  navOpts: NavOptions;
  onNavigate: Navigate;
  children: ReactNode;
}) {
  const { signOut, session } = useAuth();
  const { stores, active, select, perms } = useStore();
  const { isOnline, pendingCount, failedCount, syncing, syncNow } = useSync();

  const sections = buildSections(failedCount);
  const activeSection = sections.find((s) => isActive(s, page, navOpts));

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-e border-border bg-[var(--sidebar)] print:hidden">
        <div className="space-y-1.5 px-4 py-4">
          <span className="text-lg font-black brand-gradient-text">SUMA</span>
          {stores.length > 1 ? (
            <select
              value={active?.id ?? ""}
              onChange={(e) => select(e.target.value)}
              className="h-7 w-full rounded-md border border-input bg-background px-1 text-xs"
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.store_name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs leading-snug text-muted-foreground">{active?.store_name}</p>
          )}
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {sections
            .filter((s) => s.visible(perms))
            .map((s) => {
              const active = s === activeSection;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => onNavigate(s.page, s.opts)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start text-sm transition-colors ${
                    active
                      ? "bg-[var(--primary)] font-bold text-[var(--primary-foreground)]"
                      : "text-[var(--sidebar-foreground)] hover:bg-[var(--sidebar-accent)]"
                  }`}
                >
                  <s.icon className="size-4 shrink-0" aria-hidden />
                  <span className="flex-1 truncate">{s.label}</span>
                  {!!s.badge && s.badge > 0 && (
                    <span className="rounded-full bg-[var(--destructive)] px-1.5 text-[10px] font-bold text-white num">
                      {s.badge}
                    </span>
                  )}
                </button>
              );
            })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-1 border-b border-border px-3 py-2 print:hidden">
          {/* Quick actions — only wired to functions that already exist
              elsewhere (sync now, connectivity state); the rest are
              explicit placeholders until their behavior is specified. */}
          <div className="flex items-center gap-1">
            <IconButton
              title={isOnline ? "متصل — اضغط للمزامنة الآن" : "غير متصل — اضغط للمحاولة الآن"}
              onClick={() => void syncNow()}
            >
              {syncing ? (
                <RefreshCw className="size-4 animate-spin" aria-hidden />
              ) : failedCount > 0 ? (
                <AlertTriangle className="size-4 text-destructive" aria-hidden />
              ) : isOnline ? (
                <Wifi className="size-4 text-success" aria-hidden />
              ) : (
                <CloudOff className="size-4 text-warning" aria-hidden />
              )}
            </IconButton>
            {pendingCount > 0 && (
              <span className="text-xs text-muted-foreground num">بانتظار المزامنة: {pendingCount}</span>
            )}
            <IconButton title="بحث سريع — قريبًا" disabled>
              <Search className="size-4" aria-hidden />
            </IconButton>
            <IconButton title="إشعارات — قريبًا" disabled>
              <Bell className="size-4" aria-hidden />
            </IconButton>
          </div>

          <div className="ms-auto flex items-center gap-1">
            <IconButton title={session?.user.email ?? "المستخدم"}>
              <User className="size-4" aria-hidden />
            </IconButton>
            <IconButton title="القائمة — قريبًا" disabled>
              <Menu className="size-4" aria-hidden />
            </IconButton>
            <IconButton title="تصغير النافذة — قريبًا" disabled>
              <Minus className="size-4" aria-hidden />
            </IconButton>
            <IconButton title="خروج" onClick={() => void signOut()}>
              <Power className="size-4 text-destructive" aria-hidden />
            </IconButton>
          </div>
        </header>

        <div className="flex items-center gap-1.5 px-4 py-2 text-xs text-muted-foreground print:hidden">
          <Home className="size-3.5" aria-hidden />
          <span>الرئيسية</span>
          {activeSection && activeSection.key !== "home" && (
            <>
              <span>/</span>
              <span className="font-medium text-foreground">{activeSection.label}</span>
            </>
          )}
        </div>

        <main className="flex-1 overflow-y-auto px-4 pb-4">{children}</main>
      </div>
    </div>
  );
}

function IconButton({
  children,
  title,
  onClick,
  disabled,
}: {
  children: ReactNode;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--sidebar-accent)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
