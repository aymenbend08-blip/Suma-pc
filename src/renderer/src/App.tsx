import { useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { StoreProvider, useStore } from "@/context/StoreContext";
import { SyncProvider } from "@/context/SyncContext";
import { supabaseConfigError } from "@/lib/supabase";
import { LoginPage } from "@/pages/LoginPage";
import { HomePage, type HomeNavOptions } from "@/pages/HomePage";
import { POSPage } from "@/pages/POSPage";
import { CustomersPage } from "@/pages/CustomersPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { SyncQueuePage } from "@/pages/SyncQueuePage";
import { ComingSoonPage } from "@/pages/ComingSoonPage";
import { Shell, type Page } from "@/components/Shell";

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center">{children}</div>;
}

function AuthedApp() {
  const { loading, error, active, stores, perms, userId } = useStore();
  const [page, setPage] = useState<Page>("home");
  const [navOpts, setNavOpts] = useState<HomeNavOptions>({});

  function navigate(next: Page, opts: HomeNavOptions = {}) {
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
    (page === "customers" && !perms.canManageCustomers) ||
    (page === "dashboard" && !perms.isAdmin) ||
    (page === "sync" && !perms.isAdmin)
      ? "home"
      : page;

  return (
    <SyncProvider storeId={active.id} userId={userId}>
      <Shell page={effectivePage} onNavigate={navigate}>
        {effectivePage === "home" && <HomePage onNavigate={navigate} />}
        {effectivePage === "pos" && perms.canUsePos && <POSPage autoOpenReturn={navOpts.autoOpenReturn} />}
        {effectivePage === "customers" && perms.canManageCustomers && (
          <CustomersPage debtOnly={navOpts.debtOnly} />
        )}
        {effectivePage === "dashboard" && perms.isAdmin && <DashboardPage />}
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
