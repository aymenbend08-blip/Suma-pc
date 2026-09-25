import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseAuthStorageKey } from "@/lib/supabase";
import { decideAuthSession, parseStaleSession } from "@/lib/net";

type AuthState = {
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

function readStaleSession(): Session | null {
  return parseStaleSession<Session>(window.localStorage.getItem(supabaseAuthStorageKey));
}

/** Once per session-becoming-available, best-effort: claims any
 * store_members row an admin added for this person by phone (Phase A
 * item 8 — EmployeesPage's "add by phone" flow) before this exact
 * account existed or was ever seen by this store. Same
 * link_my_employee_accounts() RPC SUMA Web calls after sign-in;
 * idempotent (a no-op UPDATE once already linked, or if the profile has
 * no phone yet), so calling it on every fresh session is safe. Errors
 * are swallowed — this must never block or fail sign-in itself, and
 * StoreContext's own load will simply show no extra membership if this
 * didn't find anything to link. */
function linkEmployeeAccountsBestEffort(): void {
  void supabase.rpc("link_my_employee_accounts" as never, {} as never).then(
    () => {},
    () => {},
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        const resolved = decideAuthSession<Session>(
          data.session,
          error ? { message: error.message } : null,
          window.localStorage.getItem(supabaseAuthStorageKey),
        );
        setSession(resolved);
        if (resolved) linkEmployeeAccountsBestEffort();
        setLoading(false);
      })
      .catch(() => {
        // getSession() is documented to always resolve with {data, error}
        // rather than reject, but if it ever does throw (e.g. a storage
        // read failing on a cold, offline start), we must still stop
        // loading so StoreContext's offline fallback gets a chance to run
        // instead of the app hanging on a spinner forever.
        setSession(readStaleSession());
        setLoading(false);
      });
    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      if (event === "SIGNED_IN" && newSession) linkEmployeeAccountsBestEffort();
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider
      value={{ session, loading, signOut: async () => void (await supabase.auth.signOut()) }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
