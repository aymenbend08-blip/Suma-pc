import { Construction } from "lucide-react";

/** Shown for a Home tile whose feature isn't built on Desktop yet
 * (Suppliers, Purchases, Settings) — a real, honest screen instead of a
 * dead button, so it's clear the tile is a placeholder, not a bug. */
export function ComingSoonPage({ title }: { title: string }) {
  return (
    <div className="surface grid min-h-[50vh] place-items-center p-6 text-center">
      <div>
        <Construction className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden />
        <h1 className="mb-1 text-lg font-bold">{title}</h1>
        <p className="text-sm text-muted-foreground">هذه الميزة غير متوفرة بعد على SUMA للكمبيوتر — قريبًا.</p>
      </div>
    </div>
  );
}
