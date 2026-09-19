import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

const SUPABASE_URL = import.meta.env["VITE_SUPABASE_URL"] as string | undefined;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string | undefined;

/**
 * Set when .env is missing/incomplete. App.tsx checks this BEFORE
 * rendering anything that touches `supabase` and shows a friendly setup
 * screen instead — throwing here would crash the whole renderer with a
 * blank white window and no indication why, which is exactly what a
 * store owner running the packaged app (not a developer reading a
 * terminal) must never see.
 */
export const supabaseConfigError = !SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY
  ? "الإعدادات ناقصة: افتح ملف .env وتأكد من تعبئة VITE_SUPABASE_URL و VITE_SUPABASE_PUBLISHABLE_KEY."
  : null;

// Same project, same publishable (anon) key as SUMA Web — Desktop is just
// another authenticated client of the same Supabase backend, protected by
// the same RLS policies. Session persists to the renderer's localStorage
// (per-Windows-user-profile, since Electron gives each installed app its
// own isolated storage partition) so signing in survives app restarts.
//
// A placeholder URL is used when config is missing purely so createClient
// itself doesn't throw at import time — App.tsx never lets this client
// actually get called in that case (see supabaseConfigError above).
export const supabase: SupabaseClient<Database> = createClient<Database>(
  SUPABASE_URL || "https://placeholder.invalid",
  SUPABASE_PUBLISHABLE_KEY || "placeholder-key",
  {
    auth: {
      storage: window.localStorage,
      persistSession: true,
      autoRefreshToken: true,
    },
  },
);
