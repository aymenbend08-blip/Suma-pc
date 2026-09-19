import { type ReactNode } from "react";
import { LogOut, ShoppingCart, Users } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useStore } from "@/context/StoreContext";
import { Button } from "@/components/ui/button";

export type Page = "pos" | "customers";

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
        </nav>

        <Button variant="ghost" size="sm" className="ms-auto" onClick={() => void signOut()}>
          <LogOut className="size-4" aria-hidden />
          خروج
        </Button>
      </header>
      <main className="flex-1 px-3 pb-3">{children}</main>
    </div>
  );
}
