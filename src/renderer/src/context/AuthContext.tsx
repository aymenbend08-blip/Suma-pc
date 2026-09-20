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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        setSession(
          decideAuthSession<Session>(
            data.session,
            error ? { message: error.message } : null,
            window.localStorage.getItem(supabaseAuthStorageKey),
          ),
        );
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
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
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
