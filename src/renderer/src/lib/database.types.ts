/**
 * Hand-curated subset of the real SUMA Supabase schema — only the tables
 * and RPCs SUMA Desktop actually touches in this phase (Desktop Online).
 * This is NOT auto-generated and is intentionally smaller than SUMA Web's
 * full `types.ts`: SUMA Desktop is a separate, independent project and
 * does not share a build pipeline with SUMA Web, so it curates its own
 * minimal view of the shared database instead of vendoring the whole
 * generated file. Extend this as more tables/RPCs are used.
 */

export type StoreRow = {
  id: string;
  owner_id: string;
  store_name: string;
  public_identifier: string | null;
  wilaya: string | null;
  commune: string | null;
  address: string | null;
  phone: string | null;
  logo_url: string | null;
  business_type: string;
  store_size: string | null;
  is_public: boolean;
  is_active: boolean;
  show_stock_to_customers: boolean;
  created_at: string;
  updated_at: string;
  tax_rate: number;
  receipt_footer: string | null;
  working_hours: string | null;
  credit_limit: number;
  credit_overdue_days: number;
  receipt_show_qr: boolean;
};

export type StoreMemberRow = {
  id: string;
  store_id: string;
  user_id: string | null;
  role: "manager" | "employee";
  full_name: string | null;
  phone: string | null;
  can_update_price: boolean;
  can_manage_products: boolean;
  can_print_labels: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  can_use_pos: boolean;
  can_refund: boolean;
  can_manage_customers: boolean;
};

export type ProductRow = {
  id: string;
  store_id: string;
  name: string;
  description: string | null;
  barcode: string | null;
  internal_code: string | null;
  purchase_price: number | null;
  selling_price: number | null;
  stock_quantity: number;
  low_stock_threshold: number | null;
  unit: string | null;
  category_id: string | null;
  image_url: string | null;
  points_reward: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  is_low_stock: boolean;
  expiry_date: string | null;
  brand: string | null;
  product_type: string | null;
  location_in_store: string | null;
  tax_rate: number | null;
  packaging: string | null;
  specifications: string | null;
  sizes: string | null;
  label_size: string | null;
};

export type ProductVariantRow = {
  id: string;
  product_id: string;
  store_id: string;
  variant_name: string;
  barcode: string | null;
  selling_price: number | null;
  stock_quantity: number | null;
  image_url: string | null;
  attributes: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type ProductBarcodeRow = {
  id: string;
  product_id: string;
  store_id: string;
  barcode: string;
  note: string | null;
  created_at: string;
};

export type CustomerRow = {
  id: string;
  store_id: string;
  full_name: string;
  phone: string;
  status: "pending" | "approved" | "rejected";
  points_balance: number;
  credit_balance: number;
  credit_since: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
};

export type ExpenseRow = {
  id: string;
  store_id: string;
  amount: number;
  description: string;
  expense_date: string;
  created_by: string | null;
  created_at: string;
};

export type CustomerPaymentRow = {
  id: string;
  store_id: string;
  customer_id: string;
  amount: number;
  created_by: string | null;
  created_at: string;
};

export type SaleRow = {
  id: string;
  store_id: string;
  cashier_id: string;
  cashier_name: string | null;
  total_amount: number;
  item_count: number;
  created_at: string;
  occurred_at: string;
  discount_amount: number;
  payment_method: "cash" | "card" | "credit";
  refunded_amount: number;
  refunded_at: string | null;
  refunded_by: string | null;
  customer_id: string | null;
  client_request_id: string | null;
};

export type SaleItemRow = {
  id: string;
  sale_id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  variant_id: string | null;
  variant_name: string | null;
  refunded_quantity: number;
};

export type CategoryRow = {
  id: string;
  store_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  is_active: boolean;
};

export type StocktakeSessionRow = {
  id: string;
  store_id: string;
  created_by: string | null;
  notes: string | null;
  line_count: number;
  changed_count: number;
  created_at: string;
};

export type StocktakeLineRow = {
  id: string;
  session_id: string;
  product_id: string | null;
  product_name: string;
  previous_quantity: number;
  counted_quantity: number;
  delta: number;
};

export type StockMovementReason = "sale" | "return" | "purchase" | "manual" | "stocktake";

export type StockMovementRow = {
  id: string;
  store_id: string;
  product_id: string | null;
  product_name: string;
  delta: number;
  quantity_before: number;
  quantity_after: number;
  reason: StockMovementReason;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  created_by: string | null;
  client_request_id: string | null;
  created_at: string;
};

export type SupplierRow = {
  id: string;
  store_id: string;
  name: string;
  phone: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type PurchaseOrderStatus = "draft" | "partially_received" | "received" | "cancelled";

export type PurchaseOrderRow = {
  id: string;
  store_id: string;
  supplier_id: string | null;
  status: PurchaseOrderStatus;
  notes: string | null;
  total_cost: number;
  created_by: string | null;
  received_by: string | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PurchaseOrderItemRow = {
  id: string;
  purchase_order_id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit_cost: number;
  line_total: number;
  received_quantity: number;
};

type TableDef<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      stores: TableDef<StoreRow>;
      store_members: TableDef<StoreMemberRow>;
      products: TableDef<ProductRow>;
      product_barcodes: TableDef<ProductBarcodeRow>;
      product_variants: TableDef<ProductVariantRow>;
      customers: TableDef<CustomerRow>;
      customer_payments: TableDef<CustomerPaymentRow>;
      expenses: TableDef<ExpenseRow>;
      sales: TableDef<SaleRow>;
      sale_items: TableDef<SaleItemRow>;
      categories: TableDef<CategoryRow>;
      stocktake_sessions: TableDef<StocktakeSessionRow>;
      stocktake_lines: TableDef<StocktakeLineRow>;
      stock_movements: TableDef<StockMovementRow>;
      suppliers: TableDef<SupplierRow>;
      purchase_orders: TableDef<PurchaseOrderRow>;
      purchase_order_items: TableDef<PurchaseOrderItemRow>;
    };
    Views: Record<string, never>;
    Functions: {
      is_super_admin: { Args: Record<string, never>; Returns: boolean };
      is_store_admin: { Args: { _store_id: string }; Returns: boolean };
      record_sale: {
        Args: {
          _store_id: string;
          _items: unknown;
          _discount: number;
          _payment_method: string;
          _customer_id?: string;
          _client_request_id?: string;
          _occurred_at?: string;
        };
        Returns: SaleRow;
      };
      refund_sale: {
        Args: { _sale_id: string; _store_id: string; _items: unknown };
        Returns: SaleRow;
      };
      pay_customer_credit: {
        Args: { _customer_id: string; _store_id: string; _amount: number };
        Returns: CustomerRow;
      };
      adjust_stock: {
        Args: {
          _product_id: string;
          _store_id: string;
          _delta: number;
          _reason?: StockMovementReason;
          _reference_type?: string;
          _reference_id?: string;
          _notes?: string;
          _client_request_id?: string;
        };
        Returns: ProductRow;
      };
      apply_stocktake: {
        Args: { _store_id: string; _lines: unknown; _notes?: string };
        Returns: StocktakeSessionRow;
      };
      create_purchase_order: {
        Args: { _store_id: string; _items: unknown; _supplier_id?: string; _notes?: string };
        Returns: PurchaseOrderRow;
      };
      receive_purchase_order: {
        Args: { _po_id: string; _store_id: string; _items?: unknown };
        Returns: PurchaseOrderRow;
      };
      cancel_purchase_order: {
        Args: { _po_id: string; _store_id: string };
        Returns: PurchaseOrderRow;
      };
    };
    Enums: Record<string, never>;
  };
};
