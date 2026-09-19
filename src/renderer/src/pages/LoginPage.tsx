import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setLoading(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (signInError) setError(signInError.message);
  }

  return (
    <main className="flex min-h-screen items-center justify-center hero-gradient">
      <div className="w-full max-w-sm px-5">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-black brand-gradient-text">SUMA Desktop</h1>
          <p className="mt-1 text-sm text-muted-foreground">دخول أصحاب المحلات والموظفين</p>
        </div>
        <form className="surface space-y-3 p-5" onSubmit={handleSubmit}>
          <div>
            <Label htmlFor="email">الإيميل</Label>
            <Input id="email" name="email" type="email" required autoComplete="email" className="mt-1" dir="ltr" />
          </div>
          <div>
            <Label htmlFor="password">كلمة السر</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1"
              dir="ltr"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
            دخول
          </Button>
          <p className="pt-1 text-center text-xs text-muted-foreground">
            الحساب نفسه المستعمل في SUMA على الهاتف — ما كاين حساب منفصل لـDesktop.
          </p>
        </form>
      </div>
    </main>
  );
}
