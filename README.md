# SUMA Desktop

A standalone Windows desktop client for **SUMA** (السومة), connected to the
same Supabase backend as [SUMA Web](https://github.com/aymenbend08-blip/suma-store-connect-fixed).
Same design system, same business rules (same Postgres RPCs for
checkout/refund/credit), independent codebase and deployment.

**Current phase: Desktop Online + Offline (first slice).** The app now
works offline for the operations that matter most day-to-day — search,
checkout, credit repayment — and syncs automatically once back online.
See "Offline support" below for exactly what that covers and what
doesn't yet.

## What's implemented

- Electron + React 19 + TypeScript + Tailwind v4, using the exact same
  design tokens (colors, Cairo font, RTL layout) as SUMA Web.
- Login with the same SUMA account (Supabase Auth, email/password) —
  no separate Desktop account system.
- Store selection + the same permission model as SUMA Web
  (`can_use_pos`, `can_manage_customers`, owner/manager/employee roles).
- POS: barcode-scanner-friendly product search, cart, checkout — calls the
  **exact same `record_sale()` RPC** SUMA Web uses, including the same
  `client_request_id` idempotency scheme (a retried checkout after a
  network drop never creates a duplicate sale).
- Customers: list + credit balance, repayment via the same
  `pay_customer_credit()` RPC.
- Local receipt printing via Electron's native print (no thermal/ESC-POS
  integration yet — see "Next phase").

A sale made from Desktop lands in the exact same `sales`/`sale_items`
tables SUMA Web reads from, protected by the same RLS — verified directly
against the production schema (see commit history for the verification
notes).

## Offline support

A local SQLite database (`better-sqlite3`, main-process only — never
exposed to the renderer directly, only through a narrow IPC surface in
`src/preload/index.ts`) mirrors products, product barcodes, categories,
customers, stores and store memberships for the active store.

- **Reads always go through SQLite**, online or offline — product/barcode
  search and the customer list never hit Supabase directly, so they're
  equally fast and equally functional with no connection at all.
- **A background sync loop** (`src/renderer/src/context/SyncContext.tsx`)
  refreshes that local copy from Supabase every 30 seconds while online,
  and its success/failure is what actually drives the "متصل / غير متصل"
  indicator in the header — not just `navigator.onLine`, which stays true
  on a dead Wi-Fi with no real route out.
- **Checkout and credit repayment try the real RPC first**
  (`record_sale()` / `pay_customer_credit()`), exactly as in the "Online"
  phase above. Only on a network-shaped failure do they fall back to
  writing locally (decrementing local stock / local credit balance) and
  queuing that *exact same RPC call* — same arguments, same
  `client_request_id` — in a local outbox table for the sync loop to
  replay once back online. The online path itself was never changed to
  make this possible.
- **Stock and credit are never overwritten locally with an absolute
  value** — only ever a delta (sell 3 units, pay 500 DA), the same
  design the RPCs themselves already use — so a sale made offline and a
  sale made from the phone at the same time reconcile correctly no
  matter which one reaches Supabase first.
- If the app is opened with no connection at all (before any sync cycle
  has ever run), store/permission loading falls back to whatever was
  cached the last time this device was online, instead of showing an
  error screen.

**Known limits of this first slice** (see "Next phase"): reference data
is a full re-pull each cycle rather than incremental (fine at SUMA's
per-store scale, revisit if that changes), a queued operation that gets
genuinely rejected on sync (not just a network failure) surfaces as a
toast, not a dedicated review screen, and multi-device offline
conflicts beyond the stock/credit delta design above aren't specifically
tested.

## Running on Windows (development)

Requirements: [Node.js 22+](https://nodejs.org).

```bash
git clone <this-repo-url>
cd suma-desktop
npm install
copy .env.example .env
# edit .env: fill in VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
# (same values SUMA Web's own .env uses — Project Settings → API in Supabase)
npm run dev
```

This opens the app in a live-reloading Electron window.

## Building a Windows installer

Locally (works if you're already on Windows):

```bash
npm run dist:win
```

Produces an NSIS installer under `release/`.

**Recommended**: use the included GitHub Actions workflow
(`.github/workflows/build-windows.yml`) instead — it builds on a real
`windows-latest` runner, which is more reliable than cross-compiling from
another OS. It's ready to run with no setup: push to `main` or trigger
"Run workflow" manually, then download the `suma-desktop-windows`
artifact — a fully working installer, since the workflow already points
at the same public Supabase project SUMA Web uses (its anon key is safe
to keep in the workflow file — see the comment above that step).

## Project layout

```
src/main/       Electron main process — window, native printing,
                the local SQLite database (db.ts) and its IPC handlers
                (ipc-db.ts)
src/preload/    Minimal, explicit bridge exposed to the renderer
src/renderer/   The actual app (React) — src/renderer/src/
  ├─ lib/         supabase client, typed RPC wrappers, localdb.ts (typed
  │                IPC wrapper), sync.ts (hydrate/drain), format helpers
  ├─ context/     Auth + Store/permissions + Sync (offline/online, queue)
  ├─ components/  Shared UI (ported from SUMA Web's design system)
  └─ pages/       LoginPage, POSPage, CustomersPage
```

`src/renderer/src/lib/database.types.ts` is a **hand-curated subset** of
the real Supabase schema — only the tables/RPCs this app actually touches,
not a full generator dump. Extend it as more features are added.

## Next phase (not started)

- Supabase Realtime subscription for instant phone → desktop updates
  while online (today's 30s poll is simple and safe, not instant).
- A dedicated screen to review/retry sync-queue items that were
  genuinely rejected (not just a network failure) — currently a toast.
- Thermal (ESC/POS) printer + USB barcode-scanner hardware integration
  beyond the current keyboard-wedge support.
- Incremental (since-last-sync) reference-table pulls, if/when per-store
  data volume makes a full re-pull too slow.
- Offline support for the remaining POS actions (refunds, held sales)
  that SUMA Web has but this first Desktop slice doesn't yet.

See the architecture study delivered before this build for the full
reasoning behind these phases.
