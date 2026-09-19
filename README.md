# SUMA Desktop

A standalone Windows desktop client for **SUMA** (السومة), connected to the
same Supabase backend as [SUMA Web](https://github.com/aymenbend08-blip/suma-store-connect-fixed).
Same design system, same business rules (same Postgres RPCs for
checkout/refund/credit), independent codebase and deployment.

**Current phase: Desktop Online.** The app requires an internet connection —
offline/local-database support is a later, separate phase (see below).

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
another OS. Set the `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`
repository secrets first, then trigger the workflow (push to `main`, or
"Run workflow" manually) and download the `suma-desktop-windows` artifact.

## Project layout

```
src/main/       Electron main process (window, native printing)
src/preload/    Minimal, explicit bridge exposed to the renderer
src/renderer/   The actual app (React) — src/renderer/src/
  ├─ lib/         supabase client, typed RPC wrappers, format helpers
  ├─ context/     Auth + Store/permissions providers
  ├─ components/  Shared UI (ported from SUMA Web's design system)
  └─ pages/       LoginPage, POSPage, CustomersPage
```

`src/renderer/src/lib/database.types.ts` is a **hand-curated subset** of
the real Supabase schema — only the tables/RPCs this app actually touches,
not a full generator dump. Extend it as more features are added.

## Next phase (not started — explicitly out of scope for this one)

- Local SQLite mirror + offline reads.
- Offline writes (sale queue) + sync engine, reusing the same RPCs with
  the same idempotency keys.
- Thermal (ESC/POS) printer + USB barcode-scanner hardware integration
  beyond the current keyboard-wedge support.
- Supabase Realtime subscription for instant phone → desktop updates.

See the architecture study delivered before this build for the full
reasoning behind these phases.
