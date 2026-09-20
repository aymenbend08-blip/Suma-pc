import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { hydrate, drainQueue } from "@/lib/sync";
import { localDb } from "@/lib/localdb";
import { isNetworkError } from "@/lib/net";

const CYCLE_MS = 30_000;

type SyncState = {
  isOnline: boolean;
  pendingCount: number;
  failedCount: number;
  syncing: boolean;
  lastSyncAt: Date | null;
  refreshPending: () => void;
  refreshFailed: () => void;
  syncNow: () => Promise<void>;
};

const SyncContext = createContext<SyncState | null>(null);

/**
 * Drives the whole offline story from one place: pulls fresh reference
 * data into SQLite on a timer while online, drains any queued offline
 * sales/payments first on each cycle, and derives the "online" signal
 * from whether those calls actually reached Supabase — not just
 * navigator.onLine, which stays true on a dead captive-portal Wi-Fi.
 */
export function SyncProvider({
  storeId,
  userId,
  children,
}: {
  storeId: string;
  userId: string;
  children: ReactNode;
}) {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const runningRef = useRef(false);

  async function refreshPending() {
    setPendingCount(await localDb.countPendingSync());
  }

  async function refreshFailed() {
    setFailedCount(await localDb.countFailedSync());
  }

  async function runCycle() {
    if (runningRef.current) return;
    runningRef.current = true;
    setSyncing(true);
    try {
      const drainResult = await drainQueue();
      if (drainResult.synced > 0) {
        toast.success(
          drainResult.synced === 1
            ? "تمت مزامنة عملية كانت بانتظار الإنترنت."
            : `تمت مزامنة ${drainResult.synced} عمليات كانت بانتظار الإنترنت.`,
        );
      }
      if (drainResult.failed > 0) {
        toast.error(`${drainResult.failed} عملية معلّقة رُفضت عند المزامنة — راجعها من "متابعة المزامنة".`);
      }
      await refreshPending();
      await refreshFailed();

      const hydrateResult = await hydrate(storeId, userId);
      if (hydrateResult.ok) {
        setIsOnline(true);
        setLastSyncAt(new Date());
      } else if (drainResult.stoppedOffline || isNetworkError(hydrateResult.error)) {
        setIsOnline(false);
      }
    } finally {
      setSyncing(false);
      runningRef.current = false;
    }
  }

  useEffect(() => {
    void runCycle();
    const interval = setInterval(() => void runCycle(), CYCLE_MS);

    const onOnline = () => {
      setIsOnline(true);
      void runCycle();
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, userId]);

  return (
    <SyncContext.Provider
      value={{ isOnline, pendingCount, failedCount, syncing, lastSyncAt, refreshPending, refreshFailed, syncNow: runCycle }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useSync(): SyncState {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync must be used inside <SyncProvider>");
  return ctx;
}
