import { useState } from "react";
import { Loader2 } from "lucide-react";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { StoreProvider, useStore } from "@/context/StoreContext";
import { LoginPage } from "@/pages/LoginPage";
import { POSPage } from "@/pages/POSPage";
import { CustomersPage } from "@/pages/CustomersPage";
import { Shell, type Page } from "@/components/Shell";

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center">{children}</div>;
}

function AuthedApp() {
  const { loading, error, active, stores, perms } = useStore();
  const [page, setPage] = useState<Page>("pos");

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
  if (!active) return null;

  const effectivePage: Page = page === "pos" && !perms.canUsePos ? "customers" : page;

  return (
    <Shell page={effectivePage} onNavigate={setPage}>
      {effectivePage === "pos" && perms.canUsePos && <POSPage />}
      {effectivePage === "customers" && perms.canManageCustomers && <CustomersPage />}
      {!perms.canUsePos && !perms.canManageCustomers && (
        <p className="p-6 text-center text-sm text-muted-foreground">
          ما عندكش صلاحية استعمال نقطة البيع أو إدارة الزبائن في هذا المحل.
        </p>
      )}
    </Shell>
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

export function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
