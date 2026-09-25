import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The app's standard small confirm modal (same markup ProductsPage has
 * always used), shared by the product screens. `zIndexClass` lets it open
 * above another overlay such as Fiche Produit.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  pending,
  onCancel,
  onConfirm,
  destructive = true,
  zIndexClass = "z-50",
  extraAction,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  destructive?: boolean;
  zIndexClass?: string;
  /** Optional secondary action rendered between cancel and confirm. */
  extraAction?: ReactNode;
}) {
  return (
    <div className={`fixed inset-0 ${zIndexClass} grid place-items-center bg-black/40 p-4`} onClick={onCancel}>
      <div className="surface w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 font-bold">{title}</h2>
        <div className="mb-3 text-sm text-muted-foreground">{description}</div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="flex-1" onClick={onCancel}>
            إلغاء
          </Button>
          {extraAction}
          <Button variant={destructive ? "destructive" : "default"} className="flex-1" disabled={pending} onClick={onConfirm}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
