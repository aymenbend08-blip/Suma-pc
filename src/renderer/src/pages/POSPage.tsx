import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  Minus,
  Plus,
  Printer,
  ScanBarcode,
  Trash2,
  UserRound,
  X,
  Clock,
  ListChecks,
  RotateCcw,
  PackagePlus,
  Mic,
} from "lucide-react";
import { recordSale, refundSale } from "@/lib/rpc";
import { supabase } from "@/lib/supabase";
import { localDb } from "@/lib/localdb";
import { isNetworkError } from "@/lib/net";
import { useStore } from "@/context/StoreContext";
import { useAuth } from "@/context/AuthContext";
import { useSync } from "@/context/SyncContext";
import { formatDA } from "@/lib/format";
import { uuid } from "@/lib/uuid";
import { printSaleReceipt, type PrintableSale } from "@/lib/printReceipt";
import type { ReceiptItem } from "@/lib/receipt";
import type { CategoryRow, CustomerRow, ProductRow, SaleItemRow, SaleRow } from "@/lib/database.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProductFichePage } from "@/pages/ProductFichePage";
import sumaLogo from "@/assets/suma-logo.png";

const BARCODE_LIKE = /^[0-9]{6,}$/;

type CartLine = {
  key: string;
  productId: string | null;
  /** Set when the line was scanned through a variant barcode — a trace
   * only: the variant shares the base product's price and stock. Lines of
   * the same product with different variants stay separate. */
  variantId?: string | null;
  variantName?: string | null;
  name: string;
  unitPrice: number;
  quantity: number;
  stockQuantity: number;
  isCustom: boolean;
};

type HeldSale = {
  id: string;
  createdAt: string;
  cart: CartLine[];
  discount: number;
  discountMode: "amount" | "percent";
  paymentMethod: "cash" | "card" | "credit";
  customer: CustomerRow | null;
  label: string;
};

const HELD_KEY_PREFIX = "suma-pos-held-sales:";

function cartToReceiptItems(cart: CartLine[]): ReceiptItem[] {
  return cart.map((l) => ({
    name: l.name,
    variantName: l.variantName ?? null,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineTotal: l.unitPrice * l.quantity,
  }));
}

const NO_PRICE_MESSAGE = "المنتج بدون سعر بيع — حدّد سعره أولاً";

// Minimal typing for the Web Speech API (not in TS's default DOM lib) —
// same helper SUMA Web's pos.tsx uses for the exact same feature.
function getSpeechRecognition(): any {
  if (typeof window === "undefined") return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

/**
 * Checkout tries the exact same record_sale() RPC as SUMA Web's
 * pos.functions.ts `checkout` first — same params, same client_request_id
 * idempotency scheme — so an online sale from Desktop is indistinguishable
 * from one rung up on the phone. Only on a network-shaped failure does it
 * fall back to writing the sale into the local SQLite outbox for the sync
 * engine to replay against that exact same RPC once back online — the
 * online path itself is never weakened to make offline simpler.
 *
 * Custom (no-barcode) items and returns/refunds stay online-only for now —
 * the local SQLite outbox (main/db.ts createLocalSale) only knows how to
 * replay a catalog-item sale, and refund_sale() has no offline mirror at
 * all yet. Both are clearly gated on `isOnline` rather than silently
 * failing offline.
 */
export function POSPage({ autoOpenReturn = false }: { autoOpenReturn?: boolean }) {
  const { active, perms } = useStore();
  const { session } = useAuth();
  const { refreshPending, isOnline } = useSync();
  const storeId = active!.id;
  const heldKey = HELD_KEY_PREFIX + storeId;

  const [search, setSearch] = useState("");
  const [searchMode, setSearchMode] = useState<"barcode" | "name">("barcode");
  const [results, setResults] = useState<ProductRow[]>([]);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const discountRef = useRef<HTMLInputElement>(null);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [discountInput, setDiscountInput] = useState(0);
  const [discountMode, setDiscountMode] = useState<"amount" | "percent">("amount");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card" | "credit">("cash");

  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerRow[]>([]);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceLang, setVoiceLang] = useState<"ar-SA" | "fr-FR">("ar-SA");

  const [clientRequestId, setClientRequestId] = useState(() => uuid());
  const [checkingOut, setCheckingOut] = useState(false);
  const [lastSale, setLastSale] = useState<SaleRow | null>(null);
  // Snapshot of the last completed sale's printable data — captured at the
  // moment checkout succeeds, BEFORE resetCartAfterSale() clears the cart,
  // since that's the only place the line items (name/qty/price) still
  // exist. An offline sale's recordSale() response has no line items of
  // its own (only {id, total_amount}), so this is the only source for it.
  const [lastReceipt, setLastReceipt] = useState<{ sale: PrintableSale; items: ReceiptItem[]; customerName: string | null } | null>(
    null,
  );
  const [printingReceipt, setPrintingReceipt] = useState(false);

  const [now, setNow] = useState(() => new Date());
  const [showHeld, setShowHeld] = useState(false);
  const [heldSales, setHeldSales] = useState<HeldSale[]>([]);

  const [showCustomItem, setShowCustomItem] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customQty, setCustomQty] = useState("1");

  const [showFiche, setShowFiche] = useState(false);
  const [ficheBarcode, setFicheBarcode] = useState<string | undefined>(undefined);
  const [ficheCategories, setFicheCategories] = useState<CategoryRow[]>([]);

  const [showReturn, setShowReturn] = useState(false);
  const [returnLoading, setReturnLoading] = useState(false);
  const [recentSales, setRecentSales] = useState<SaleRow[]>([]);
  const [returnSale, setReturnSale] = useState<SaleRow | null>(null);
  const [returnItems, setReturnItems] = useState<SaleItemRow[]>([]);
  const [returnQty, setReturnQty] = useState<Record<string, number>>({});
  const [returnSubmitting, setReturnSubmitting] = useState(false);
  // One idempotency key per refund attempt: kept across a retry of the
  // same selection (refund_sale returns the already-applied result instead
  // of refunding twice), renewed when the selection changes or succeeds.
  const [refundRequestId, setRefundRequestId] = useState(() => uuid());

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // "إرجاع من زبون" on the home screen lands here with the return dialog
  // already open, instead of duplicating its fetch/selection logic there.
  useEffect(() => {
    if (autoOpenReturn) void openReturnDialog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live clock for the invoice-info card — real time, not a fabricated
  // sequential invoice number (Desktop has no pre-allocated numbering
  // scheme the way the reference software does).
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(heldKey);
      setHeldSales(raw ? (JSON.parse(raw) as HeldSale[]) : []);
    } catch {
      setHeldSales([]);
    }
  }, [heldKey]);

  function persistHeld(next: HeldSale[]) {
    setHeldSales(next);
    try {
      localStorage.setItem(heldKey, JSON.stringify(next));
    } catch {
      // best-effort only — losing a held-sale draft is recoverable (cashier
      // just re-enters it), never worth surfacing an error mid-sale for.
    }
  }

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
      // Barcode mode hides rows that matched by name only; a row matched
      // through an extra or variant barcode (not visible on the product row
      // itself) is kept.
      const lowered = term.toLowerCase();
      const filtered =
        searchMode === "barcode"
          ? rows.filter((p) => p.barcode?.includes(term) || !p.name.toLowerCase().includes(lowered))
          : rows;
      setResults(filtered);
      setSearching(false);
    });
    return () => {
      cancelled = true;
    };
  }, [search, storeId, searchMode]);

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

  function addToCart(p: ProductRow, variant: { id: string; name: string } | null = null) {
    // record_sale rejects a product with no selling price — refuse it here
    // instead of letting the whole checkout fail later.
    if (p.selling_price === null || p.selling_price === undefined) {
      toast.error(`${NO_PRICE_MESSAGE}: ${p.name}`);
      return;
    }
    const variantId = variant?.id ?? null;
    setCart((lines) => {
      const sameLine = (l: CartLine) => l.productId === p.id && (l.variantId ?? null) === variantId;
      const existing = lines.find(sameLine);
      if (existing) {
        return lines.map((l) => (sameLine(l) ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [
        ...lines,
        {
          key: uuid(),
          productId: p.id,
          variantId,
          variantName: variant?.name ?? null,
          name: p.name,
          unitPrice: Number(p.selling_price),
          quantity: 1,
          stockQuantity: Number(p.stock_quantity),
          isCustom: false,
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
    // Exact code first, through the full 3-step resolution on the local
    // mirror (main barcode -> extra barcode -> active variant barcode), so
    // a scan works offline and a variant scan keeps its variant.
    const hit = await localDb.findProductByBarcode(storeId, term);
    if (hit) {
      if (!hit.is_active) {
        toast.error(`المنتج «${hit.name}» غير مفعّل.`);
        return;
      }
      return addToCart(
        hit,
        hit.matched_variant_id ? { id: hit.matched_variant_id, name: hit.matched_variant_name ?? "" } : null,
      );
    }
    if (results.length === 1) return addToCart(results[0]);

    // A barcode-shaped term that matched nothing at all — offer to add it
    // as a new product right here, instead of just failing the scan.
    // Creating a product is an online-only, admin-ish action (same
    // reasoning as everywhere else catalog writes happen in this app), so
    // this is gated on both permission and connectivity.
    // Creating a product is store-admin only (RLS products_admin_insert).
    if (BARCODE_LIKE.test(term) && perms.isAdmin && isOnline) {
      void openFicheForBarcode(term);
      return;
    }
    toast.error("ما لقيناش منتج بهذا الباركود أو الاسم.");
  }

  async function openFicheForBarcode(barcode: string) {
    if (ficheCategories.length === 0) {
      const { data, error } = await supabase.from("categories").select("*").eq("store_id", storeId).order("sort_order");
      if (error) {
        toast.error(error.message);
        return;
      }
      setFicheCategories(data ?? []);
    }
    setFicheBarcode(barcode);
    setShowFiche(true);
  }

  function updateQuantity(key: string, delta: number) {
    setCart((lines) =>
      lines
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  }

  function removeLine(key: string) {
    setCart((lines) => lines.filter((l) => l.key !== key));
    setSelectedKey((k) => (k === key ? null : k));
  }

  function addCustomItem() {
    const name = customName.trim();
    const price = Number(customPrice);
    const qty = Number(customQty) || 1;
    if (!name) {
      toast.error("لازم اسم للصنف.");
      return;
    }
    if (!(price >= 0)) {
      toast.error("سعر غير صالح.");
      return;
    }
    setCart((lines) => [
      ...lines,
      {
        key: uuid(),
        productId: null,
        name,
        unitPrice: price,
        quantity: qty,
        stockQuantity: 0,
        isCustom: true,
      },
    ]);
    setCustomName("");
    setCustomPrice("");
    setCustomQty("1");
    setShowCustomItem(false);
    searchRef.current?.focus();
  }

  function startVoiceSearch() {
    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      toast.error("المتصفح ما يدعمش التعرف على الصوت.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = voiceLang;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onerror = () => {
      setListening(false);
      toast.error("ما قدرناش نسمعو صح، جرب تكتب الاسم.");
    };
    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      if (transcript) setCustomerQuery(transcript);
    };
    recognition.start();
  }

  const subtotal = cart.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const discount =
    discountMode === "percent"
      ? Math.min(subtotal, (subtotal * (discountInput || 0)) / 100)
      : Math.min(subtotal, discountInput || 0);
  const total = Math.max(0, subtotal - discount);
  const itemCount = cart.reduce((sum, l) => sum + l.quantity, 0);
  const hasCustomItem = cart.some((l) => l.isCustom);
  // Informational only — overselling is allowed on purpose (matches
  // record_sale()'s 20260919200000 migration), so this never blocks
  // checkout. Only meaningful while offline: online, the server is the
  // authoritative source and this locally-cached figure can be stale.
  // Variant lines share the base product's stock, so compare the product's
  // total quantity across all its lines.
  const qtyByProduct = new Map<string, number>();
  for (const l of cart) if (l.productId) qtyByProduct.set(l.productId, (qtyByProduct.get(l.productId) ?? 0) + l.quantity);
  const isShort = (l: CartLine) => !l.isCustom && !!l.productId && (qtyByProduct.get(l.productId) ?? 0) > l.stockQuantity;
  const insufficientLines = !isOnline ? cart.filter(isShort) : [];
  const blockedOffline = !isOnline && hasCustomItem;

  async function checkout() {
    if (cart.length === 0) return;
    if (blockedOffline) {
      toast.error("السلة فيها صنف بدون باركود — يحتاج اتصال بالإنترنت لإتمام البيع.");
      return;
    }
    setCheckingOut(true);
    const { data, error } = await recordSale({
      _store_id: storeId,
      _items: cart.map((l) =>
        l.isCustom
          ? { name: l.name, unit_price: l.unitPrice, quantity: l.quantity }
          : {
              product_id: l.productId as string,
              ...(l.variantId ? { variant_id: l.variantId } : {}),
              quantity: l.quantity,
            },
      ),
      _discount: discount,
      _payment_method: paymentMethod,
      ...(customer ? { _customer_id: customer.id } : {}),
      _client_request_id: clientRequestId,
    });

    if (!error && data) {
      setCheckingOut(false);
      setLastSale(data);
      setLastReceipt({ sale: data, items: cartToReceiptItems(cart), customerName: customer?.full_name ?? null });
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
        items: cart.map((l) => ({ productId: l.productId as string, quantity: l.quantity, variantId: l.variantId ?? null })),
        discount,
        paymentMethod,
        customerId: customer?.id ?? null,
        clientRequestId,
      });
      setCheckingOut(false);
      toast.success(`تم البيع (بدون إنترنت) — ${formatDA(localSale.total_amount)} — سيُزامن تلقائيًا.`);
      // recordSale()'s response has no line items of its own when it
      // comes back offline (createLocalSale only returns {id,
      // total_amount}) — build the printable snapshot from what's known
      // at this exact moment (the cart) instead, same as the online path.
      setLastReceipt({
        sale: {
          id: localSale.id,
          occurred_at: new Date().toISOString(),
          cashier_name: session!.user.email ?? null,
          payment_method: paymentMethod,
          discount_amount: discount,
          total_amount: localSale.total_amount,
          refunded_amount: 0,
        },
        items: cartToReceiptItems(cart),
        customerName: customer?.full_name ?? null,
      });
      refreshPending();
      resetCartAfterSale();
    } catch (localError) {
      setCheckingOut(false);
      toast.error(localError instanceof Error ? localError.message : "تعذر إتمام البيع حتى محليًا.");
    }
  }

  function resetCartAfterSale() {
    setCart([]);
    setSelectedKey(null);
    setDiscountInput(0);
    setDiscountMode("amount");
    setCustomer(null);
    setPaymentMethod("cash");
    setClientRequestId(uuid());
    searchRef.current?.focus();
  }

  /** Prints the real 80mm receipt template (Phase A item 1) for the last
   * completed sale — nothing to print if no sale has completed yet this
   * session (there's no visible-window fallback anymore; a dedicated
   * receipt needs actual sale data, not "whatever's on screen"). */
  async function printReceipt() {
    if (!lastReceipt || !active) {
      toast.error("لا توجد فاتورة لطباعتها بعد.");
      return;
    }
    setPrintingReceipt(true);
    const res = await printSaleReceipt({ store: active, sale: lastReceipt.sale, items: lastReceipt.items, customerName: lastReceipt.customerName });
    setPrintingReceipt(false);
    if (!res.ok) toast.error("تعذرت الطباعة — تحقق من الطابعة الافتراضية.");
  }

  function holdSale() {
    if (cart.length === 0) {
      toast.error("السلة فارغة — لا يوجد ما يُعلَّق.");
      return;
    }
    const held: HeldSale = {
      id: uuid(),
      createdAt: new Date().toISOString(),
      cart,
      discount: discountInput,
      discountMode,
      paymentMethod,
      customer,
      label: customer ? customer.full_name : `${itemCount} صنف`,
    };
    persistHeld([held, ...heldSales]);
    resetCartAfterSale();
    toast.success("تم تعليق الفاتورة — تقدر تسترجعها من قائمة المعلّقة.");
  }

  function restoreHeld(h: HeldSale) {
    if (cart.length > 0) {
      toast.error("فرّغ السلة الحالية أو علّقها أولًا قبل استرجاع فاتورة معلّقة.");
      return;
    }
    setCart(h.cart);
    setDiscountInput(h.discount);
    setDiscountMode(h.discountMode);
    setPaymentMethod(h.paymentMethod);
    setCustomer(h.customer);
    persistHeld(heldSales.filter((x) => x.id !== h.id));
    setShowHeld(false);
    toast.success("تم استرجاع الفاتورة المعلّقة.");
  }

  function discardHeld(id: string) {
    persistHeld(heldSales.filter((x) => x.id !== id));
  }

  async function openReturnDialog() {
    setShowReturn(true);
    setReturnSale(null);
    setReturnItems([]);
    setReturnQty({});
    if (!isOnline) return;
    setReturnLoading(true);
    const { data, error } = await supabase
      .from("sales")
      .select("*")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(20);
    setReturnLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setRecentSales(data ?? []);
  }

  async function selectReturnSale(s: SaleRow) {
    setReturnSale(s);
    setReturnLoading(true);
    const { data, error } = await supabase.from("sale_items").select("*").eq("sale_id", s.id);
    setReturnLoading(false);
    if (error) {
      toast.error(error.message);
      setReturnSale(null);
      return;
    }
    const items = data ?? [];
    setReturnItems(items);
    const initial: Record<string, number> = {};
    for (const item of items) initial[item.id] = 0;
    setReturnQty(initial);
    setRefundRequestId(uuid());
  }

  async function submitReturn() {
    if (!returnSale) return;
    const items = Object.entries(returnQty)
      .filter(([, qty]) => qty > 0)
      .map(([sale_item_id, quantity]) => ({ sale_item_id, quantity }));
    if (items.length === 0) {
      toast.error("حدّد كمية الإرجاع لصنف واحد على الأقل.");
      return;
    }
    if (!perms.canRefund) {
      toast.error("الإرجاع يحتاج صلاحية الاسترجاع.");
      return;
    }
    setReturnSubmitting(true);
    const { error } = await refundSale({
      _sale_id: returnSale.id,
      _store_id: storeId,
      _items: items,
      _client_request_id: refundRequestId,
    });
    setReturnSubmitting(false);
    if (error) {
      // Same key is reused if the cashier retries this exact selection.
      toast.error(error.message);
      return;
    }
    setRefundRequestId(uuid());
    toast.success("تم تسجيل الإرجاع بنجاح.");
    setShowReturn(false);
    setReturnSale(null);
  }

  // ---- Keyboard shortcuts (mirrors the physical F-key layout cashiers
  // already use on the reference register software) ----------------------
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "F3") {
        e.preventDefault();
        void openReturnDialog();
      } else if (e.key === "F4") {
        e.preventDefault();
        if (!checkingOut) void checkout();
      } else if (e.key === "F5") {
        e.preventDefault();
        void printReceipt();
      } else if (e.key === "F6") {
        e.preventDefault();
        setShowCustomItem(true);
      } else if (e.key === "F8") {
        e.preventDefault();
        holdSale();
      } else if (e.key === "F9") {
        e.preventDefault();
        discountRef.current?.focus();
      } else if (e.key === "F10") {
        e.preventDefault();
        setSearchMode("barcode");
        searchRef.current?.focus();
      } else if (e.key === "Delete" && !inField && selectedKey) {
        e.preventDefault();
        removeLine(selectedKey);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, cart, heldSales, discountInput, discountMode, paymentMethod, customer, isOnline, checkingOut]);

  const dateLabel = useMemo(
    () => now.toLocaleString("ar-DZ", { dateStyle: "medium", timeStyle: "medium" }),
    [now],
  );

  return (
    <div className="space-y-3">
      {/* ---- Header block: totals (right, ~70%) + store/invoice card (left, ~30%) ---- */}
      <div className="grid gap-3 lg:grid-cols-[7fr_3fr]">
        <div className="rounded-2xl bg-[var(--foreground)] p-4 text-white">
          <div className="text-xs text-white/60">المجموع الكلي</div>
          <div className="text-5xl font-black num text-[var(--accent)]" dir="ltr">
            {total.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="mt-3 flex items-center gap-4 border-t border-white/10 pt-2 text-xs">
            <span className="text-white/60">
              خصم (F9)
              <input
                ref={discountRef}
                type="number"
                min={0}
                value={discountInput || ""}
                onChange={(e) => setDiscountInput(Number(e.target.value) || 0)}
                className="ms-2 w-20 rounded bg-white/10 px-1.5 py-0.5 text-white num outline-none"
                dir="ltr"
              />
            </span>
            <div className="flex overflow-hidden rounded border border-white/20 text-[11px]">
              <button
                type="button"
                onClick={() => setDiscountMode("amount")}
                className={`px-2 py-0.5 ${discountMode === "amount" ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "text-white/70"}`}
              >
                دج
              </button>
              <button
                type="button"
                onClick={() => setDiscountMode("percent")}
                className={`px-2 py-0.5 ${discountMode === "percent" ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "text-white/70"}`}
              >
                %
              </button>
            </div>
            <span className="ms-auto text-white/60">
              المجموع الصافي <span className="num font-bold text-white">{formatDA(total)}</span>
            </span>
          </div>
        </div>

        <div className="surface flex flex-col items-center gap-1 p-3 text-center">
          <div className="w-full text-[11px] text-muted-foreground num" dir="ltr">
            {dateLabel}
          </div>
          <div className="text-lg font-black text-[var(--destructive)]">{active?.store_name}</div>
          <p className="text-xs text-muted-foreground">نرحب بزبائننا الكرام</p>
          <div className="flex w-full items-center justify-center gap-3 text-[11px] text-muted-foreground">
            <span>
              عدد الأصناف: <span className="num font-medium text-foreground">{cart.length}</span>
            </span>
            <span>
              الكمية: <span className="num font-medium text-foreground">{itemCount}</span>
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-1 w-full"
            onClick={() => void openReturnDialog()}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            بيع / إرجاع [F3]
          </Button>
        </div>
      </div>

      {/* ---- Main working area: search + table (right) / control panel (left) ---- */}
      <div className="grid gap-3 lg:grid-cols-[7fr_3fr]">
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
            <div className="mt-2 flex items-center gap-4 text-xs">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  checked={searchMode === "barcode"}
                  onChange={() => setSearchMode("barcode")}
                />
                باركود (F10)
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  checked={searchMode === "name"}
                  onChange={() => setSearchMode("name")}
                />
                الاسم
              </label>
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
                        {p.selling_price === null ? <span className="text-destructive">بدون سعر</span> : formatDA(p.selling_price)} · مخزون{" "}
                        {p.stock_quantity}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="surface overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--primary)] text-[var(--primary-foreground)]">
                  <th className="px-3 py-2 text-start font-bold">الصنف</th>
                  <th className="w-20 px-2 py-2 text-center font-bold">الكمية</th>
                  <th className="w-24 px-2 py-2 text-center font-bold">السعر</th>
                  <th className="w-28 px-2 py-2 text-center font-bold">المجموع</th>
                </tr>
              </thead>
              <tbody>
                {cart.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                      السلة فارغة
                    </td>
                  </tr>
                ) : (
                  cart.map((l, i) => {
                    const insufficient = !isOnline && isShort(l);
                    return (
                      <tr
                        key={l.key}
                        onClick={() => setSelectedKey(l.key)}
                        className={`cursor-pointer border-b border-border last:border-0 ${
                          selectedKey === l.key ? "bg-[var(--accent)]/20" : i % 2 === 1 ? "bg-[var(--muted)]" : "bg-white"
                        }`}
                      >
                        <td className="px-3 py-1.5">
                          <span className="block truncate">
                            {l.name}
                            {l.isCustom && (
                              <span className="ms-1 text-[10px] text-muted-foreground">(بدون باركود)</span>
                            )}
                          </span>
                          {l.variantName && (
                            <span className="block text-xs font-medium text-[var(--primary)]">{l.variantName}</span>
                          )}
                          {insufficient && (
                            <span className="text-xs font-medium text-destructive">
                              غير متوفر محليًا — الموجود: {l.stockQuantity}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              variant="outline"
                              size="icon"
                              className="size-6"
                              onClick={(e) => {
                                e.stopPropagation();
                                updateQuantity(l.key, -1);
                              }}
                            >
                              <Minus className="size-3" aria-hidden />
                            </Button>
                            <span className="w-6 text-center num">{l.quantity}</span>
                            <Button
                              variant="outline"
                              size="icon"
                              className="size-6"
                              onClick={(e) => {
                                e.stopPropagation();
                                updateQuantity(l.key, 1);
                              }}
                            >
                              <Plus className="size-3" aria-hidden />
                            </Button>
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-center num">{formatDA(l.unitPrice)}</td>
                        <td className="px-2 py-1.5 text-center num font-medium">
                          {formatDA(l.unitPrice * l.quantity)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="flex h-fit flex-col gap-3">
          <div className="surface flex items-center justify-around p-1.5">
            <Button variant="ghost" size="icon" onClick={() => setShowHeld((v) => !v)} title="الفواتير المعلّقة">
              <ListChecks className="size-4" aria-hidden />
              {heldSales.length > 0 && (
                <span className="absolute -translate-y-3 translate-x-3 rounded-full bg-[var(--destructive)] px-1 text-[9px] text-white num">
                  {heldSales.length}
                </span>
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={!lastReceipt || printingReceipt}
              onClick={() => void printReceipt()}
              title="طباعة آخر فاتورة [F5]"
            >
              {printingReceipt ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Printer className="size-4" aria-hidden />}
            </Button>
          </div>

          {showHeld && (
            <div className="surface p-2">
              <h3 className="mb-1 px-1 text-xs font-bold text-muted-foreground">الفواتير المعلّقة</h3>
              {heldSales.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">لا توجد فواتير معلّقة</p>
              ) : (
                <ul className="divide-y divide-border">
                  {heldSales.map((h) => (
                    <li key={h.id} className="flex items-center gap-2 py-1.5 text-xs">
                      <button
                        type="button"
                        className="flex-1 text-start hover:text-primary"
                        onClick={() => restoreHeld(h)}
                      >
                        {h.label} — {formatDA(h.cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0))}
                      </button>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => discardHeld(h.id)}
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={!selectedKey}
              onClick={() => selectedKey && removeLine(selectedKey)}
            >
              <Trash2 className="size-3.5" aria-hidden />
              حذف السطر
            </Button>
            <Button variant="destructive" size="sm" onClick={holdSale}>
              <Clock className="size-3.5" aria-hidden />
              تعليق [F8]
            </Button>
          </div>

          <Button variant="secondary" size="sm" onClick={() => setShowCustomItem(true)}>
            <PackagePlus className="size-3.5" aria-hidden />
            صنف بدون باركود [F6]
          </Button>

          <div className="surface p-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => setShowCustomerPicker((v) => !v)}
            >
              <UserRound className="size-4" aria-hidden />
              {customer ? (
                <span className="flex min-w-0 flex-col items-start leading-tight">
                  <span className="truncate">{customer.full_name}</span>
                  <span className="text-[10px] font-normal text-muted-foreground num">
                    نقاط: {Number(customer.points_balance).toLocaleString("fr-FR")} · دين: {formatDA(customer.credit_balance)}
                  </span>
                </span>
              ) : (
                "بدون زبون (اختياري)"
              )}
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
                <div className="flex items-center gap-1.5">
                  <Input
                    value={customerQuery}
                    onChange={(e) => setCustomerQuery(e.target.value)}
                    placeholder="اسم أو هاتف الزبون..."
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-9 shrink-0 px-2 text-xs"
                    onClick={() => setVoiceLang((l) => (l === "ar-SA" ? "fr-FR" : "ar-SA"))}
                    title="بدّل لغة البحث الصوتي"
                  >
                    {voiceLang === "ar-SA" ? "عربي" : "FR"}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant={listening ? "default" : "outline"}
                    className="size-9 shrink-0"
                    onClick={startVoiceSearch}
                    title="ابحث بالصوت"
                  >
                    <Mic className="size-4" aria-hidden />
                  </Button>
                </div>
                {listening && (
                  <p className="text-xs text-muted-foreground">
                    جاري الاستماع بال{voiceLang === "ar-SA" ? "عربية" : "فرنسية"}...
                  </p>
                )}
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
                          <span className="block">
                            {c.full_name} — <span className="num">{c.phone}</span>
                          </span>
                          <span className="block text-[10px] text-muted-foreground num">
                            نقاط: {Number(c.points_balance).toLocaleString("fr-FR")} · دين: {formatDA(c.credit_balance)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="mt-2 grid grid-cols-3 gap-1">
              {(["cash", "card", "credit"] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  variant={paymentMethod === m ? "default" : "outline"}
                  size="sm"
                  disabled={m === "credit" && !customer}
                  onClick={() => setPaymentMethod(m)}
                  className={
                    paymentMethod === m
                      ? m === "cash"
                        ? "bg-[var(--success)] text-[var(--success-foreground)] hover:bg-[var(--success)]/90"
                        : ""
                      : ""
                  }
                >
                  {m === "cash" ? "نقدًا" : m === "card" ? "بطاقة" : "كريدي"}
                </Button>
              ))}
            </div>

            {/* record_sale() itself never enforces credit_limit server-side
                (confirmed against the live RPC — it's a soft, informational
                figure only, same on SUMA Web) — this is a non-blocking
                heads-up for the cashier, never a checkout block, consistent
                with what the server will actually allow. */}
            {paymentMethod === "credit" && customer && active && Number(customer.credit_balance) + total > Number(active.credit_limit) && Number(active.credit_limit) > 0 && (
              <p className="mt-2 text-xs font-medium text-[var(--warning-foreground)]">
                تنبيه: هذا البيع سيتجاوز سقف الدّين المسموح لهذا الزبون ({formatDA(active.credit_limit)}).
              </p>
            )}
          </div>

          {blockedOffline && (
            <p className="text-xs font-medium text-destructive">
              السلة فيها صنف بدون باركود — يحتاج اتصال بالإنترنت لإتمام البيع.
            </p>
          )}

          <Button
            size="lg"
            disabled={cart.length === 0 || checkingOut || blockedOffline}
            onClick={() => void checkout()}
          >
            {checkingOut && <Loader2 className="size-4 animate-spin" aria-hidden />}
            إتمام البيع [F4]
          </Button>

          {lastSale && (
            <div className="rounded-md border border-border p-2 text-xs text-muted-foreground">
              <p>آخر بيع: {formatDA(lastSale.total_amount)}</p>
              <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void printReceipt()}>
                <Printer className="size-3.5" aria-hidden />
                طباعة الفاتورة [F5]
              </Button>
            </div>
          )}

          <div className="surface flex flex-col items-center gap-1 p-3 text-center">
            <img src={sumaLogo} alt="SUMA" className="size-14 rounded-xl" />
            <p className="text-xs font-bold text-muted-foreground">إختياركم الأفضل</p>
          </div>
        </aside>
      </div>

      {/* ---- Fiche Produit — opens as an overlay right on top of the POS
          screen when a scanned barcode matches nothing, so adding the
          missing product and getting straight back to the sale never
          leaves this screen. ---- */}
      {showFiche && (
        <ProductFichePage
          storeId={storeId}
          product={null}
          categories={ficheCategories}
          initialBarcode={ficheBarcode}
          onClose={() => {
            setShowFiche(false);
            setFicheBarcode(undefined);
          }}
          onSaved={(row) => {
            setShowFiche(false);
            setFicheBarcode(undefined);
            addToCart(row);
          }}
        />
      )}

      {/* ---- Custom no-barcode item dialog ---- */}
      {showCustomItem && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          onClick={() => setShowCustomItem(false)}
        >
          <div className="surface w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 font-bold">صنف بدون باركود</h2>
            <div className="space-y-2">
              <Input
                autoFocus
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="اسم الصنف"
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="number"
                  min={0}
                  value={customPrice}
                  onChange={(e) => setCustomPrice(e.target.value)}
                  placeholder="السعر (دج)"
                />
                <Input
                  type="number"
                  min={1}
                  value={customQty}
                  onChange={(e) => setCustomQty(e.target.value)}
                  placeholder="الكمية"
                />
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setShowCustomItem(false)}>
                إلغاء
              </Button>
              <Button className="flex-1" onClick={addCustomItem}>
                إضافة للسلة
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Return / refund dialog — online only, picks from recent sales ---- */}
      {showReturn && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          onClick={() => setShowReturn(false)}
        >
          <div
            className="surface flex max-h-[85vh] w-full max-w-lg flex-col p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-3 font-bold">إرجاع / استرجاع بيع سابق</h2>
            {!isOnline ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                الإرجاع يحتاج اتصال بالإنترنت حاليًا.
              </p>
            ) : returnLoading ? (
              <div className="grid place-items-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
              </div>
            ) : !returnSale ? (
              <ul className="divide-y divide-border overflow-y-auto">
                {recentSales.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">لا توجد مبيعات حديثة</p>
                ) : (
                  recentSales.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-2 py-2 text-start text-sm hover:bg-accent/40"
                        onClick={() => void selectReturnSale(s)}
                      >
                        <span>
                          {formatDA(s.total_amount)} · {s.item_count} صنف
                        </span>
                        <span className="text-xs text-muted-foreground num" dir="ltr">
                          {new Date(s.created_at).toLocaleString("ar-DZ", { dateStyle: "short", timeStyle: "short" })}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : (
              <>
                <button
                  type="button"
                  className="mb-2 self-start text-xs text-primary hover:underline"
                  onClick={() => setReturnSale(null)}
                >
                  ← رجوع لقائمة المبيعات
                </button>
                <ul className="divide-y divide-border overflow-y-auto">
                  {returnItems.map((item) => {
                    const maxQty = item.quantity - item.refunded_quantity;
                    return (
                      <li key={item.id} className="flex items-center gap-2 py-2 text-sm">
                        <span className="flex-1 truncate">
                          {item.product_name}
                          {item.variant_name && <span className="ms-1 text-xs text-[var(--primary)]">({item.variant_name})</span>}
                        </span>
                        <span className="text-xs text-muted-foreground num">
                          ({item.quantity - item.refunded_quantity} متاح)
                        </span>
                        <Input
                          type="number"
                          min={0}
                          max={maxQty}
                          disabled={maxQty <= 0}
                          value={returnQty[item.id] || ""}
                          onChange={(e) => {
                            // A different selection is a different attempt.
                            setRefundRequestId(uuid());
                            setReturnQty((q) => ({
                              ...q,
                              [item.id]: Math.max(0, Math.min(maxQty, Number(e.target.value) || 0)),
                            }));
                          }}
                          className="w-16"
                        />
                      </li>
                    );
                  })}
                </ul>
                {!perms.canRefund && (
                  <p className="mt-2 text-xs text-muted-foreground">الإرجاع يحتاج صلاحية الاسترجاع — اطلبها من صاحب المحل.</p>
                )}
                <Button className="mt-3" disabled={returnSubmitting || !perms.canRefund} onClick={() => void submitReturn()}>
                  {returnSubmitting && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  تأكيد الإرجاع
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
