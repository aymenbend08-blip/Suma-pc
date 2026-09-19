import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Minus, Plus, Printer, ScanBarcode, Trash2, UserRound, X } from "lucide-react";
import { recordSale } from "@/lib/rpc";
import { localDb } from "@/lib/localdb";
import { isNetworkError } from "@/lib/net";
import { useStore } from "@/context/StoreContext";
import { useAuth } from "@/context/AuthContext";
import { useSync } from "@/context/SyncContext";
import { formatDA } from "@/lib/format";
import { uuid } from "@/lib/uuid";
import type { CustomerRow, ProductRow, SaleRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type CartLine = {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  stockQuantity: number;
};

/**
 * Checkout tries the exact same record_sale() RPC as SUMA Web's
 * pos.functions.ts `checkout` first — same params, same client_request_id
 * idempotency scheme — so an online sale from Desktop is indistinguishable
 * from one rung up on the phone. Only on a network-shaped failure does it
 * fall back to writing the sale into the local SQLite outbox for the sync
 * engine to replay against that exact same RPC once back online — the
 * online path itself is never weakened to make offline simpler.
 */
export function POSPage() {
  const { active } = useStore();
  const { session } = useAuth();
  const { refreshPending, isOnline } = useSync();
  const storeId = active!.id;

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ProductRow[]>([]);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card" | "credit">("cash");

  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerRow[]>([]);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);

  const [clientRequestId, setClientRequestId] = useState(() => uuid());
  const [checkingOut, setCheckingOut] = useState(false);
  const [lastSale, setLastSale] = useState<SaleRow | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Search always reads the local SQLite mirror — never a live Supabase
  // query — so it's equally fast and equally functional online or
  // offline, and the sync engine (SyncContext) is what keeps this data
  // fresh in the background. No debounce needed: this is a local query.
  useEffect(() => {
    const term = search.trim();
    if (!term) {
      setResults([]);
      return;
    }
    setSearching(true);
    let cancelled = false;
    void localDb.searchProducts(storeId, term).then((rows) => {
      if (cancelled) return;
      setResults(rows);
      setSearching(false);
    });
    return () => {
      cancelled = true;
    };
  }, [search, storeId]);

  useEffect(() => {
    const term = customerQuery.trim();
    if (!term) {
      setCustomerResults([]);
      return;
    }
    let cancelled = false;
    void localDb.searchCustomers(storeId, term).then((rows) => {
      if (!cancelled) setCustomerResults(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [customerQuery, storeId]);

  function addToCart(p: ProductRow) {
    setCart((lines) => {
      const existing = lines.find((l) => l.productId === p.id);
      if (existing) {
        return lines.map((l) =>
          l.productId === p.id ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [
        ...lines,
        {
          productId: p.id,
          name: p.name,
          unitPrice: Number(p.selling_price),
          quantity: 1,
          stockQuantity: Number(p.stock_quantity),
        },
      ];
    });
    setSearch("");
    setResults([]);
    searchRef.current?.focus();
  }

  async function handleSearchEnter() {
    const term = search.trim();
    if (!term) return;
    const exact = results.find((p) => p.barcode === term);
    if (exact) return addToCart(exact);
    if (results.length === 1) return addToCart(results[0]);

    // Not a primary barcode / not narrowed to one match yet — check
    // product_barcodes aliases (a product can have more than one barcode),
    // also against the local mirror so a scan works offline too.
    const product = await localDb.findProductByBarcode(storeId, term);
    if (product) return addToCart(product);
    toast.error("ما لقيناش منتج بهذا الباركود أو الاسم.");
  }

  function updateQuantity(productId: string, delta: number) {
    setCart((lines) =>
      lines
        .map((l) => (l.productId === productId ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  }

  function removeLine(productId: string) {
    setCart((lines) => lines.filter((l) => l.productId !== productId));
  }

  const subtotal = cart.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const total = Math.max(0, subtotal - discount);
  // Only meaningful while offline: online, record_sale() is the
  // authoritative stock check and this locally-cached figure can be
  // stale. Offline, it's the same check createLocalSale() will run
  // anyway — surfacing it here lets the cashier fix the cart before
  // trying, instead of after.
  const insufficientLines = !isOnline ? cart.filter((l) => l.quantity > l.stockQuantity) : [];

  async function checkout() {
    if (cart.length === 0) return;
    if (insufficientLines.length > 0) {
      toast.error(
        `المخزون المحلي غير كافٍ لـ ${insufficientLines.map((l) => l.name).join("، ")} — قلّل الكمية أو انتظر الاتصال.`,
      );
      return;
    }
    setCheckingOut(true);
    const { data, error } = await recordSale({
      _store_id: storeId,
      _items: cart.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
      _discount: discount,
      _payment_method: paymentMethod,
      ...(customer ? { _customer_id: customer.id } : {}),
      _client_request_id: clientRequestId,
    });

    if (!error && data) {
      setCheckingOut(false);
      setLastSale(data);
      toast.success(`تم البيع بنجاح — ${formatDA(data.total_amount)}`);
      resetCartAfterSale();
      return;
    }

    const message = error?.message ?? "تعذر إتمام البيع.";
    if (!isNetworkError(message)) {
      setCheckingOut(false);
      toast.error(message);
      return;
    }

    // Offline (or the request never reached Supabase) — record the sale
    // locally with the exact same client_request_id, and queue that same
    // record_sale() call for the sync engine to replay once back online.
    // The cashier sees success either way; nothing about the sale cycle
    // itself branches on connectivity beyond this one fallback.
    try {
      const localSale = await localDb.createLocalSale({
        id: clientRequestId,
        storeId,
        cashierId: session!.user.id,
        cashierName: session!.user.email ?? null,
        items: cart.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        discount,
        paymentMethod,
        customerId: customer?.id ?? null,
        clientRequestId,
      });
      setCheckingOut(false);
      toast.success(`تم البيع (بدون إنترنت) — ${formatDA(localSale.total_amount)} — سيُزامن تلقائيًا.`);
      refreshPending();
      resetCartAfterSale();
    } catch (localError) {
      setCheckingOut(false);
      toast.error(localError instanceof Error ? localError.message : "تعذر إتمام البيع حتى محليًا.");
    }
  }

  function resetCartAfterSale() {
    setCart([]);
    setDiscount(0);
    setCustomer(null);
    setPaymentMethod("cash");
    setClientRequestId(uuid());
    searchRef.current?.focus();
  }

  async function printReceipt() {
    if (window.suma?.printSilent) {
      const res = await window.suma.printSilent();
      if (!res.ok) toast.error("تعذرت الطباعة — تحقق من الطابعة الافتراضية.");
    } else {
      window.print();
    }
  }

  return (
    <div className="grid gap-3 md:grid-cols-[1fr_360px]">
      <section className="space-y-3">
        <div className="surface p-3">
          <div className="flex items-center gap-2">
            <ScanBarcode className="size-5 text-muted-foreground" aria-hidden />
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSearchEnter();
                }
              }}
              placeholder="امسح الباركود أو اكتب اسم المنتج..."
              className="flex-1"
              autoFocus
            />
            {searching && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />}
          </div>
          {results.length > 0 && (
            <ul className="mt-2 max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
              {results.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => addToCart(p)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-accent/40"
                  >
                    <span className="truncate">{p.name}</span>
                    <span className="shrink-0 text-muted-foreground num">
                      {formatDA(p.selling_price)} · مخزون {p.stock_quantity}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="surface flex-1 p-3">
          <h2 className="mb-2 text-sm font-bold">السلة</h2>
          {cart.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">السلة فارغة</p>
          ) : (
            <ul className="divide-y divide-border">
              {cart.map((l) => {
                const insufficient = !isOnline && l.quantity > l.stockQuantity;
                return (
                <li key={l.productId} className="flex items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{l.name}</span>
                    {insufficient && (
                      <span className="text-xs font-medium text-destructive">
                        غير متوفر محليًا — الموجود: {l.stockQuantity}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="icon" className="size-7" onClick={() => updateQuantity(l.productId, -1)}>
                      <Minus className="size-3" aria-hidden />
                    </Button>
                    <span className="w-8 text-center text-sm num">{l.quantity}</span>
                    <Button variant="outline" size="icon" className="size-7" onClick={() => updateQuantity(l.productId, 1)}>
                      <Plus className="size-3" aria-hidden />
                    </Button>
                  </div>
                  <span className="w-24 text-end text-sm font-medium num">
                    {formatDA(l.unitPrice * l.quantity)}
                  </span>
                  <Button variant="ghost" size="icon" className="size-7 text-destructive" onClick={() => removeLine(l.productId)}>
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <aside className="surface flex h-fit flex-col gap-3 p-4">
        <div className="text-3xl font-black num">{formatDA(total)}</div>

        <div>
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => setShowCustomerPicker((v) => !v)}>
            <UserRound className="size-4" aria-hidden />
            {customer ? customer.full_name : "بدون زبون (اختياري)"}
            {customer && (
              <X
                className="ms-auto size-4"
                onClick={(e) => {
                  e.stopPropagation();
                  setCustomer(null);
                }}
              />
            )}
          </Button>
          {showCustomerPicker && !customer && (
            <div className="mt-2 space-y-2">
              <Input
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                placeholder="اسم أو هاتف الزبون..."
              />
              {customerResults.length > 0 && (
                <ul className="max-h-40 divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {customerResults.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-1.5 text-start text-sm hover:bg-accent/40"
                        onClick={() => {
                          setCustomer(c);
                          setShowCustomerPicker(false);
                          setCustomerQuery("");
                        }}
                      >
                        {c.full_name} — {c.phone}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-1">
          {(["cash", "card", "credit"] as const).map((m) => (
            <Button
              key={m}
              type="button"
              variant={paymentMethod === m ? "default" : "outline"}
              size="sm"
              disabled={m === "credit" && !customer}
              onClick={() => setPaymentMethod(m)}
            >
              {m === "cash" ? "نقدًا" : m === "card" ? "بطاقة" : "كريدي"}
            </Button>
          ))}
        </div>

        <div>
          <label className="text-xs text-muted-foreground">تخفيض (دج)</label>
          <Input
            type="number"
            min={0}
            value={discount || ""}
            onChange={(e) => setDiscount(Number(e.target.value) || 0)}
          />
        </div>

        <Button
          size="lg"
          disabled={cart.length === 0 || checkingOut || insufficientLines.length > 0}
          onClick={() => void checkout()}
        >
          {checkingOut && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {insufficientLines.length > 0 ? "المخزون المحلي غير كافٍ" : "إتمام البيع"}
        </Button>

        {lastSale && (
          <div className="rounded-md border border-border p-2 text-xs text-muted-foreground">
            <p>آخر بيع: {formatDA(lastSale.total_amount)}</p>
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void printReceipt()}>
              <Printer className="size-3.5" aria-hidden />
              طباعة الفاتورة
            </Button>
          </div>
        )}
      </aside>
    </div>
  );
}
