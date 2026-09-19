/** Same formatting rules as SUMA Web — Algerian Dinar, no decimals for whole amounts. */
export function formatDA(amount: number | string | null | undefined): string {
  const n = Number(amount ?? 0);
  return `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} دج`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("ar-DZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
