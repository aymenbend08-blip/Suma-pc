import { type ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  CloudOff,
  Home,
  Loader2,
  LogOut,
  RefreshCw,
  ShoppingCart,
  Users,
  Wifi,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useStore } from "@/context/StoreContext";
import { useSync } from "@/context/SyncContext";
import { Button } from "@/components/ui/button";

export type Page = "home" | "pos" | "customers" | "dashboard" | "sync" | "coming-soon";

export function Shell({
  page,
  onNavigate,
  children,
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  children: ReactNode;
}) {
  const { signOut } = useAuth();
  const { stores, active, select, perms } = useStore();
  const { isOnline, pendingCount, failedCount, syncing } = useSync();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="surface m-3 flex items-center gap-3 rounded-2xl px-4 py-2.5 print:hidden">
        <span className="text-lg font-black brand-gradient-text">SUMA</span>
        {stores.length > 1 ? (
          <select
            value={active?.id ?? ""}
            onChange={(e) => select(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.store_name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-muted-foreground">{active?.store_name}</span>
        )}

        <nav className="ms-2 flex items-center gap-1">
          <Button
            variant={page === "home" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onNavigate("home")}
          >
            <Home className="size-4" aria-hidden />
            الرئيسية
          </Button>
          {perms.canUsePos && (
            <Button
              variant={page === "pos" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => onNavigate("pos")}
            >
              <ShoppingCart className="size-4" aria-hidden />
              نقطة البيع
            </Button>
          )}
          {perms.canManageCustomers && (
            <Button
              variant={page === "customers" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => onNavigate("customers")}
            >
              <Users className="size-4" aria-hidden />
              الزبائن
            </Button>
          )}
          {perms.isAdmin && (
            <Button
              variant={page === "dashboard" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => onNavigate("dashboard")}
            >
              <BarChart3 className="size-4" aria-hidden />
              الإحصائيات
            </Button>
          )}
          {perms.isAdmin && (
            <Button
              variant={page === "sync" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => onNavigate("sync")}
            >
              <RefreshCw className="size-4" aria-hidden />
              متابعة المزامنة
              {failedCount > 0 && (
                <span className="rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground num">
                  {failedCount}
                </span>
              )}
            </Button>
          )}
        </nav>

        <button
          type="button"
          onClick={() => perms.isAdmin && onNavigate("sync")}
          className={`ms-auto flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            failedCount > 0
              ? "bg-destructive/15 text-destructive"
              : isOnline
                ? "bg-success/15 text-success"
                : "bg-warning/20 text-warning"
          } ${perms.isAdmin ? "cursor-pointer" : "cursor-default"}`}
          title={
            failedCount > 0
              ? `${failedCount} عملية فشلت نهائيًا — تحتاج مراجعة`
              : isOnline
                ? "متصل بالإنترنت"
                : "غير متصل — العمل مستمر محليًا"
          }
        >
          {failedCount > 0 ? (
            <AlertTriangle className="size-3.5" aria-hidden />
          ) : syncing ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : isOnline ? (
            <Wifi className="size-3.5" aria-hidden />
          ) : (
            <CloudOff className="size-3.5" aria-hidden />
          )}
          {failedCount > 0 ? `${failedCount} فشلت` : isOnline ? "متصل" : "غير متصل"}
          {pendingCount > 0 && <span className="num">({pendingCount})</span>}
        </button>

        <Button variant="ghost" size="sm" onClick={() => void signOut()}>
          <LogOut className="size-4" aria-hidden />
          خروج
        </Button>
      </header>
      <main className="flex-1 px-3 pb-3">{children}</main>
    </div>
  );
}
