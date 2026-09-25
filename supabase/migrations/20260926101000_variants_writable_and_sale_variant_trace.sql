-- Variants: make them manageable, and record which one was sold.
--
-- 1) product_variants already has RLS write policies (insert/update: admin or
--    can_manage_products; delete: admin only) but `authenticated` only ever
--    had a SELECT grant, so every write was rejected before RLS even ran.
--    Granting the privileges lets those existing policies do their job —
--    no policy is widened. The owner-only variant price trigger and the new
--    cross-table barcode trigger both keep applying.
--
-- 2) record_sale(): SUMA's documented model (20260901033035, "sales always
--    apply to the base product only") is kept exactly — a variant shares its
--    parent's price and stock, so SUMA Web (which never sends a variant) and
--    SUMA PC can never disagree about stock. What changes is traceability:
--    an optional `variant_id` on a catalog line is validated against that
--    product and written to sale_items.variant_id / variant_name, columns
--    that already existed but were never filled. An unknown or foreign
--    variant_id is ignored rather than rejected, so a queued offline sale
--    whose variant was deleted before it synced still goes through.
--
-- 3) record_sale(): a product with a NULL selling_price (allowed since
--    20260910104631, and produced by imports without a price) used to make
--    checkout fail on `sales.total_amount NOT NULL` with an opaque error.
--    It now fails up front with a message naming the product.
--
-- Same 7-argument signature, so CREATE OR REPLACE replaces in place.

GRANT INSERT, UPDATE, DELETE ON public.product_variants TO authenticated;

CREATE OR REPLACE FUNCTION public.record_sale(
  _store_id uuid,
  _items jsonb,
  _discount numeric DEFAULT 0,
  _payment_method text DEFAULT 'cash'::text,
  _customer_id uuid DEFAULT NULL::uuid,
  _client_request_id uuid DEFAULT NULL::uuid,
  _occurred_at timestamptz DEFAULT NULL::timestamptz
)
RETURNS sales
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _sale public.sales;
  _item jsonb;
  _product public.products;
  _qty numeric;
  _unit_price numeric;
  _offline_unit_price numeric;
  _custom_name text;
  _custom_price numeric;
  _line_total numeric := 0;
  _total numeric := 0;
  _count integer := 0;
  _cashier_name text;
  _discount_clamped numeric;
  _points_total numeric := 0;
  _customer public.customers;
  _variant_id uuid;
  _variant_name text;
BEGIN
  IF NOT (
    public.is_store_admin(_store_id)
    OR EXISTS (
      SELECT 1 FROM public.store_members m
      WHERE m.store_id = _store_id AND m.user_id = auth.uid() AND m.is_active AND m.can_use_pos
    )
  ) THEN
    RAISE EXCEPTION 'ما عندكش صلاحية البيع في هذا المحل.' USING ERRCODE = '42501';
  END IF;

  IF _client_request_id IS NOT NULL THEN
    SELECT * INTO _sale FROM public.sales
    WHERE store_id = _store_id AND client_request_id = _client_request_id;
    IF FOUND THEN
      RETURN _sale;
    END IF;
  END IF;

  IF jsonb_array_length(_items) = 0 THEN
    RAISE EXCEPTION 'السلة فارغة.';
  END IF;

  IF _payment_method NOT IN ('cash', 'card', 'credit') THEN
    RAISE EXCEPTION 'طريقة دفع غير صالحة.';
  END IF;

  IF _customer_id IS NOT NULL THEN
    SELECT * INTO _customer FROM public.customers
    WHERE id = _customer_id AND store_id = _store_id AND status = 'approved'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'الزبون غير موجود أو غير مؤكَّد.';
    END IF;
  END IF;

  IF _payment_method = 'credit' AND _customer_id IS NULL THEN
    RAISE EXCEPTION 'لازم تختار زبون مؤكَّد باش تبيع على الكريدي.';
  END IF;

  SELECT COALESCE(sm.full_name, p.full_name, '') INTO _cashier_name
  FROM public.store_members sm
  LEFT JOIN public.profiles p ON p.id = sm.user_id
  WHERE sm.store_id = _store_id AND sm.user_id = auth.uid();

  BEGIN
    INSERT INTO public.sales
      (store_id, cashier_id, cashier_name, total_amount, item_count, payment_method, customer_id, client_request_id, occurred_at)
    VALUES (
      _store_id, auth.uid(), NULLIF(_cashier_name, ''), 0, 0, _payment_method, _customer_id, _client_request_id,
      LEAST(COALESCE(_occurred_at, now()), now())
    )
    RETURNING * INTO _sale;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO _sale FROM public.sales
    WHERE store_id = _store_id AND client_request_id = _client_request_id;
    RETURN _sale;
  END;

  FOR _item IN SELECT * FROM jsonb_array_elements(_items) LOOP
    _qty := (_item->>'quantity')::numeric;
    IF _qty IS NULL OR _qty <= 0 THEN
      RAISE EXCEPTION 'كمية غير صالحة.';
    END IF;

    IF (_item->>'product_id') IS NOT NULL THEN
      SELECT * INTO _product FROM public.products
      WHERE id = (_item->>'product_id')::uuid AND store_id = _store_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'منتج غير موجود في هذا المحل.';
      END IF;

      _variant_id := NULLIF(_item->>'variant_id', '')::uuid;
      _variant_name := NULL;
      IF _variant_id IS NOT NULL THEN
        SELECT v.variant_name INTO _variant_name
        FROM public.product_variants v
        WHERE v.id = _variant_id AND v.product_id = _product.id AND v.store_id = _store_id;
        IF NOT FOUND THEN
          _variant_id := NULL;
          _variant_name := NULL;
        END IF;
      END IF;

      _offline_unit_price := NULLIF(_item->>'unit_price', '')::numeric;
      IF _offline_unit_price IS NOT NULL THEN
        IF _offline_unit_price < 0 THEN
          RAISE EXCEPTION 'سعر غير صالح للمنتج.';
        END IF;
        IF _offline_unit_price IS DISTINCT FROM _product.selling_price
           AND NOT EXISTS (
             SELECT 1 FROM public.price_history ph
             WHERE ph.product_id = _product.id AND ph.new_price = _offline_unit_price
           )
        THEN
          RAISE EXCEPTION 'السعر المرسل غير مطابق لسعر هذا المنتج.' USING ERRCODE = '42501';
        END IF;
        _unit_price := _offline_unit_price;
      ELSE
        _unit_price := _product.selling_price;
      END IF;

      IF _unit_price IS NULL THEN
        RAISE EXCEPTION 'المنتج «%» ما عندوش سعر بيع — حدّد سعره قبل البيع.', _product.name;
      END IF;

      _line_total := _unit_price * _qty;
      _total := _total + _line_total;
      _count := _count + _qty;
      _points_total := _points_total + (COALESCE(_product.points_reward, 0) * _qty);

      INSERT INTO public.sale_items (sale_id, product_id, product_name, quantity, unit_price, line_total, variant_id, variant_name)
      VALUES (_sale.id, _product.id, _product.name, _qty, _unit_price, _line_total, _variant_id, _variant_name);

      UPDATE public.products SET stock_quantity = stock_quantity - _qty WHERE id = _product.id;

      INSERT INTO public.stock_movements
        (store_id, product_id, product_name, delta, quantity_before, quantity_after, reason, reference_type, reference_id, created_by)
      VALUES
        (_store_id, _product.id, _product.name, -_qty, _product.stock_quantity, _product.stock_quantity - _qty, 'sale', 'sale', _sale.id, auth.uid());
    ELSE
      _custom_name := NULLIF(trim(_item->>'name'), '');
      _custom_price := (_item->>'unit_price')::numeric;
      IF _custom_name IS NULL THEN
        RAISE EXCEPTION 'لازم اسم للمنتج بدون باركود.';
      END IF;
      IF _custom_price IS NULL OR _custom_price < 0 THEN
        RAISE EXCEPTION 'سعر غير صالح للمنتج بدون باركود.';
      END IF;

      _line_total := _custom_price * _qty;
      _total := _total + _line_total;
      _count := _count + _qty;

      INSERT INTO public.sale_items (sale_id, product_id, product_name, quantity, unit_price, line_total)
      VALUES (_sale.id, NULL, _custom_name, _qty, _custom_price, _line_total);
    END IF;
  END LOOP;

  _discount_clamped := LEAST(GREATEST(COALESCE(_discount, 0), 0), _total);

  UPDATE public.sales SET total_amount = _total - _discount_clamped, item_count = _count, discount_amount = _discount_clamped
  WHERE id = _sale.id RETURNING * INTO _sale;

  IF _customer_id IS NOT NULL THEN
    UPDATE public.customers
    SET points_balance = points_balance + _points_total,
        credit_balance = credit_balance + (CASE WHEN _payment_method = 'credit' THEN _sale.total_amount ELSE 0 END),
        credit_since = CASE
          WHEN _payment_method = 'credit' AND credit_balance <= 0 THEN now()
          ELSE credit_since
        END
    WHERE id = _customer_id;
  END IF;

  RETURN _sale;
END;
$function$;

NOTIFY pgrst, 'reload schema';
