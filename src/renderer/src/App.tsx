import { useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { StoreProvider, useStore } from "@/context/StoreContext";
import { SyncProvider } from "@/context/SyncContext";
import { supabaseConfigError } from "@/lib/supabase";
import { LoginPage } from "@/pages/LoginPage";
import { HomePage } from "@/pages/HomePage";
import { POSPage } from "@/pages/POSPage";
import { ProductsPage } from "@/pages/ProductsPage";
import { StockPage } from "@/pages/StockPage";
import { PurchasesPage } from "@/pages/PurchasesPage";
import { CustomersPage } from "@/pages/CustomersPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { SalesHistoryPage } from "@/pages/SalesHistoryPage";
import { CashRegisterPage } from "@/pages/CashRegisterPage";
import { ExpensesPage } from "@/pages/ExpensesPage";
import { EmployeesPage } from "@/pages/EmployeesPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SyncQueuePage } from "@/pages/SyncQueuePage";
import { ComingSoonPage } from "@/pages/ComingSoonPage";
import { Shell, type NavOptions, type Page } from "@/components/Shell";

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center">{children}</div>;
}

function AuthedApp() {
  const { loading, error, active, stores, perms, userId } = useStore();
  const [page, setPage] = useState<Page>("home");
  const [navOpts, setNavOpts] = useState<NavOptions>({});

  function navigate(next: Page, opts: NavOptions = {}) {
    setNavOpts(opts);
    setPage(next);
  }

  if (loading) {
    return (
      <Centered>
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
      </Centered>
    );
  }
  if (error) {
    return (
      <Centered>
        <p className="text-sm text-destructive">{error}</p>
      </Centered>
    );
  }
  if (stores.length === 0) {
    return (
      <Centered>
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          ما كاين أي محل مرتبط بهذا الحساب. سجّل دخول بحساب صاحب محل أو موظف مضاف في SUMA.
        </p>
      </Centered>
    );
  }
  if (!active || !userId) return null;

  const effectivePage: Page =
    (page === "pos" && !perms.canUsePos) ||
    (page === "stock" && !perms.canManageProducts) ||
    (page === "purchases" && !perms.canManageProducts) ||
    (page === "customers" && !perms.canManageCustomers) ||
    (page === "dashboard" && !perms.isAdmin) ||
    (page === "sales-history" && !perms.isAdmin) ||
    (page === "cash-register" && !perms.canUsePos) ||
    (page === "expenses" && !perms.isAdmin) ||
    (page === "employees" && !perms.isAdmin) ||
    (page === "settings" && !perms.isAdmin) ||
    (page === "sync" && !perms.isAdmin)
      ? "home"
      : page;

  return (
    <SyncProvider storeId={active.id} userId={userId}>
      <Shell page={effectivePage} navOpts={navOpts} onNavigate={navigate}>
        {effectivePage === "home" && <HomePage onNavigate={navigate} />}
        {effectivePage === "pos" && perms.canUsePos && <POSPage autoOpenReturn={navOpts.autoOpenReturn} />}
        {/* Every member may browse the catalog (SUMA Web shows المنتجات to all
            members, read-only without can_manage_products); writes inside
            are gated per action and by RLS. */}
        {effectivePage === "products" && <ProductsPage />}
        {effectivePage === "stock" && perms.canManageProducts && <StockPage />}
        {effectivePage === "purchases" && perms.canManageProducts && <PurchasesPage openSuppliers={navOpts.openSuppliers} />}
        {effectivePage === "customers" && perms.canManageCustomers && (
          <CustomersPage debtOnly={navOpts.debtOnly} />
        )}
        {effectivePage === "dashboard" && perms.isAdmin && <DashboardPage />}
        {effectivePage === "sales-history" && perms.isAdmin && <SalesHistoryPage />}
        {effectivePage === "cash-register" && perms.canUsePos && <CashRegisterPage />}
        {effectivePage === "expenses" && perms.isAdmin && <ExpensesPage />}
        {effectivePage === "employees" && perms.isAdmin && <EmployeesPage />}
        {/* Keyed on the active store id: SettingsPage seeds its form
            fields once from `store.xxx` via useState initializers (the
            simplest option, since every value is already synchronously
            available on StoreRow) rather than an effect-driven reload —
            the key forces a full remount on a multi-store switch so
            those fields aren't left showing the previous store's data. */}
        {effectivePage === "settings" && perms.isAdmin && active && <SettingsPage key={active.id} />}
        {effectivePage === "sync" && perms.isAdmin && <SyncQueuePage />}
        {effectivePage === "coming-soon" && <ComingSoonPage title={navOpts.comingSoonTitle ?? "قريبًا"} />}
      </Shell>
    </SyncProvider>
  );
}

function Gate() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <Centered>
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
      </Centered>
    );
  }
  if (!session) return <LoginPage />;

  return (
    <StoreProvider>
      <AuthedApp />
    </StoreProvider>
  );
}

function ConfigErrorScreen({ message }: { message: string }) {
  return (
    <Centered>
      <div className="surface max-w-sm space-y-2 p-5 text-center">
        <TriangleAlert className="mx-auto size-8 text-warning" aria-hidden />
        <p className="text-sm font-medium">{message}</p>
        <p className="text-xs text-muted-foreground">
          راجع ملف .env.example في مجلد البرنامج لمعرفة القيم المطلوبة.
        </p>
      </div>
    </Centered>
  );
}

export function App() {
  if (supabaseConfigError) return <ConfigErrorScreen message={supabaseConfigError} />;

  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
