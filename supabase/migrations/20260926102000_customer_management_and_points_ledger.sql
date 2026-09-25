-- Customer management + loyalty points ledger.
--
-- A) create_customer / update_customer
--    Until now a customer could only come into existence through the public
--    storefront signup (service role) followed by staff approval. The RLS
--    policy `customers_admin_write` would let an admin write rows directly,
--    but it would equally let that write touch credit_balance and
--    points_balance, which must only ever move through the ledgered RPCs.
--    These two functions are the narrow alternative: they only ever touch
--    full_name / phone (and status on create), and they are also open to
--    staff with can_manage_customers — the same flag that already gates
--    pay_customer_credit and decide_customer_request — who could not write
--    the table at all under RLS.
--
-- B) customer_points_ledger
--    points_balance changed silently: record_sale / add_item_to_sale add,
--    refund_sale subtracts, and nothing recorded why. A trigger on
--    customers.points_balance now writes one ledger row per change, so the
--    history is complete no matter which code path moved the balance —
--    without touching those hot-path RPCs. The reason is taken from a
--    transaction-local setting when the caller sets one
--    (adjust_customer_points does), otherwise inferred: a sale created in
--    this same transaction (sales.created_at = now(), constant within a
--    transaction) → 'sale'; a sale refunded in this transaction → 'refund';
--    any other increase → 'sale_edit' (add_item_to_sale); anything else →
--    'system'. Existing balances get one opening row so the ledger sums to
--    the current balance from day one.
--
-- C) adjust_customer_points
--    Manual adjustment (±, store admins only) and redemption (deduction
--    only, admins or can_manage_customers). Locked, idempotent on
--    client_request_id, never lets the balance go below zero.

-- ---------------------------------------------------------------- A

CREATE OR REPLACE FUNCTION public.create_customer(_store_id uuid, _full_name text, _phone text)
RETURNS public.customers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _name text := btrim(COALESCE(_full_name, ''));
  _ph text := btrim(COALESCE(_phone, ''));
  _row public.customers;
  _existing public.customers;
BEGIN
  IF NOT (
    public.is_store_admin(_store_id)
    OR EXISTS (
      SELECT 1 FROM public.store_members m
      WHERE m.store_id = _store_id AND m.user_id = auth.uid() AND m.is_active AND m.can_manage_customers
    )
  ) THEN
    RAISE EXCEPTION 'ما عندكش صلاحية إدارة الزبائن.' USING ERRCODE = '42501';
  END IF;
  IF length(_name) < 2 OR length(_name) > 120 THEN
    RAISE EXCEPTION 'اسم الزبون لازم يكون بين 2 و120 حرف.';
  END IF;
  IF length(_ph) < 8 OR length(_ph) > 30 THEN
    RAISE EXCEPTION 'رقم الهاتف غير صالح.';
  END IF;

  SELECT * INTO _existing FROM public.customers WHERE store_id = _store_id AND phone = _ph;
  IF FOUND THEN
    IF _existing.status = 'pending' THEN
      RAISE EXCEPTION 'هذا الرقم عنده طلب تسجيل قيد التأكيد — اقبله من تبويب الطلبات.';
    ELSIF _existing.status = 'rejected' THEN
      RAISE EXCEPTION 'هذا الرقم عنده طلب مرفوض من قبل.';
    ELSE
      RAISE EXCEPTION 'هذا الرقم مسجّل أصلاً لزبون: %.', _existing.full_name;
    END IF;
  END IF;

  INSERT INTO public.customers (store_id, full_name, phone, status, approved_by, approved_at)
  VALUES (_store_id, _name, _ph, 'approved', auth.uid(), now())
  RETURNING * INTO _row;
  RETURN _row;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'هذا الرقم مسجّل أصلاً لزبون في محلك.';
END;
$$;

CREATE OR REPLACE FUNCTION public.update_customer(_customer_id uuid, _store_id uuid, _full_name text, _phone text)
RETURNS public.customers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _name text := btrim(COALESCE(_full_name, ''));
  _ph text := btrim(COALESCE(_phone, ''));
  _row public.customers;
BEGIN
  IF NOT (
    public.is_store_admin(_store_id)
    OR EXISTS (
      SELECT 1 FROM public.store_members m
      WHERE m.store_id = _store_id AND m.user_id = auth.uid() AND m.is_active AND m.can_manage_customers
    )
  ) THEN
    RAISE EXCEPTION 'ما عندكش صلاحية إدارة الزبائن.' USING ERRCODE = '42501';
  END IF;
  IF length(_name) < 2 OR length(_name) > 120 THEN
    RAISE EXCEPTION 'اسم الزبون لازم يكون بين 2 و120 حرف.';
  END IF;
  IF length(_ph) < 8 OR length(_ph) > 30 THEN
    RAISE EXCEPTION 'رقم الهاتف غير صالح.';
  END IF;

  UPDATE public.customers SET full_name = _name, phone = _ph
  WHERE id = _customer_id AND store_id = _store_id
  RETURNING * INTO _row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الزبون غير موجود.';
  END IF;
  RETURN _row;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'هذا الرقم مسجّل أصلاً لزبون آخر في محلك.';
END;
$$;

REVOKE ALL ON FUNCTION public.create_customer(uuid, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.update_customer(uuid, uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_customer(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_customer(uuid, uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------- B

CREATE TABLE IF NOT EXISTS public.customer_points_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  delta numeric(12,2) NOT NULL,
  balance_after numeric(12,2) NOT NULL,
  reason text NOT NULL CHECK (reason IN ('opening', 'sale', 'refund', 'sale_edit', 'manual_adjust', 'redeem', 'system')),
  reference_type text,
  reference_id uuid,
  notes text,
  client_request_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_points_ledger_customer
  ON public.customer_points_ledger (store_id, customer_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_points_ledger_store_client_request
  ON public.customer_points_ledger (store_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE public.customer_points_ledger ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.customer_points_ledger TO authenticated;
GRANT ALL ON public.customer_points_ledger TO service_role;

DROP POLICY IF EXISTS points_ledger_read ON public.customer_points_ledger;
CREATE POLICY points_ledger_read ON public.customer_points_ledger
  FOR SELECT TO authenticated
  USING (
    public.is_store_admin(store_id)
    OR EXISTS (
      SELECT 1 FROM public.store_members m
      WHERE m.store_id = customer_points_ledger.store_id AND m.user_id = auth.uid()
        AND m.is_active AND m.can_manage_customers
    )
  );

CREATE OR REPLACE FUNCTION public.log_customer_points_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _delta numeric := NEW.points_balance - OLD.points_balance;
  _reason text := NULLIF(current_setting('suma.points_reason', true), '');
  _notes text := NULLIF(current_setting('suma.points_notes', true), '');
  _crid uuid := NULLIF(current_setting('suma.points_client_request_id', true), '')::uuid;
  _ref_type text;
  _ref_id uuid;
BEGIN
  IF _reason IS NULL THEN
    SELECT s.id INTO _ref_id FROM public.sales s
    WHERE s.customer_id = NEW.id AND s.store_id = NEW.store_id AND s.created_at = now()
    LIMIT 1;
    IF _ref_id IS NOT NULL THEN
      _reason := 'sale';
      _ref_type := 'sale';
    ELSE
      SELECT s.id INTO _ref_id FROM public.sales s
      WHERE s.customer_id = NEW.id AND s.store_id = NEW.store_id AND s.refunded_at = now()
      LIMIT 1;
      IF _ref_id IS NOT NULL THEN
        _reason := 'refund';
        _ref_type := 'sale';
      ELSIF _delta > 0 THEN
        _reason := 'sale_edit';
      ELSE
        _reason := 'system';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.customer_points_ledger
    (store_id, customer_id, delta, balance_after, reason, reference_type, reference_id, notes, client_request_id, created_by)
  VALUES
    (NEW.store_id, NEW.id, _delta, NEW.points_balance, _reason, _ref_type, _ref_id, _notes, _crid, auth.uid());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_points_ledger ON public.customers;
CREATE TRIGGER trg_customers_points_ledger
  AFTER UPDATE OF points_balance ON public.customers
  FOR EACH ROW
  WHEN (OLD.points_balance IS DISTINCT FROM NEW.points_balance)
  EXECUTE FUNCTION public.log_customer_points_change();

INSERT INTO public.customer_points_ledger (store_id, customer_id, delta, balance_after, reason, notes)
SELECT c.store_id, c.id, c.points_balance, c.points_balance, 'opening', 'رصيد النقاط قبل تفعيل سجل الحركات'
FROM public.customers c
WHERE c.points_balance <> 0
  AND NOT EXISTS (SELECT 1 FROM public.customer_points_ledger l WHERE l.customer_id = c.id);

-- ---------------------------------------------------------------- C

CREATE OR REPLACE FUNCTION public.adjust_customer_points(
  _customer_id uuid,
  _store_id uuid,
  _delta numeric,
  _reason text DEFAULT 'manual_adjust',
  _notes text DEFAULT NULL,
  _client_request_id uuid DEFAULT NULL
)
RETURNS public.customers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _customer public.customers;
BEGIN
  IF _reason NOT IN ('manual_adjust', 'redeem') THEN
    RAISE EXCEPTION 'نوع عملية النقاط غير صالح.';
  END IF;

  IF _reason = 'manual_adjust' THEN
    IF NOT public.is_store_admin(_store_id) THEN
      RAISE EXCEPTION 'تعديل النقاط يدويًا محجوز لصاحب المحل والمدير.' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT (
      public.is_store_admin(_store_id)
      OR EXISTS (
        SELECT 1 FROM public.store_members m
        WHERE m.store_id = _store_id AND m.user_id = auth.uid() AND m.is_active AND m.can_manage_customers
      )
    ) THEN
      RAISE EXCEPTION 'ما عندكش صلاحية استبدال النقاط.' USING ERRCODE = '42501';
    END IF;
    IF _delta >= 0 THEN
      RAISE EXCEPTION 'الاستبدال لازم ينقص النقاط.';
    END IF;
  END IF;

  IF _delta IS NULL OR _delta = 0 OR abs(_delta) > 1000000 THEN
    RAISE EXCEPTION 'عدد النقاط غير صالح.';
  END IF;

  IF _client_request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.customer_points_ledger
    WHERE store_id = _store_id AND client_request_id = _client_request_id
  ) THEN
    SELECT * INTO _customer FROM public.customers WHERE id = _customer_id AND store_id = _store_id;
    RETURN _customer;
  END IF;

  SELECT * INTO _customer FROM public.customers
  WHERE id = _customer_id AND store_id = _store_id AND status = 'approved'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الزبون غير موجود أو غير مؤكَّد.';
  END IF;

  -- Re-check under the row lock: a concurrent retry of the same request
  -- blocked on FOR UPDATE above and must not apply the delta twice.
  IF _client_request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.customer_points_ledger
    WHERE store_id = _store_id AND client_request_id = _client_request_id
  ) THEN
    RETURN _customer;
  END IF;

  IF _customer.points_balance + _delta < 0 THEN
    RAISE EXCEPTION 'رصيد النقاط غير كافٍ (المتاح: %).', _customer.points_balance;
  END IF;

  PERFORM set_config('suma.points_reason', _reason, true);
  PERFORM set_config('suma.points_notes', COALESCE(left(btrim(_notes), 300), ''), true);
  PERFORM set_config('suma.points_client_request_id', COALESCE(_client_request_id::text, ''), true);

  UPDATE public.customers SET points_balance = points_balance + _delta
  WHERE id = _customer_id
  RETURNING * INTO _customer;

  PERFORM set_config('suma.points_reason', '', true);
  PERFORM set_config('suma.points_notes', '', true);
  PERFORM set_config('suma.points_client_request_id', '', true);

  RETURN _customer;
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_customer_points(uuid, uuid, numeric, text, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.adjust_customer_points(uuid, uuid, numeric, text, text, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
