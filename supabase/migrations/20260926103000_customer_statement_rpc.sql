-- get_customer_statement: a real account statement (كشف حساب) computed in
-- the database, with a running balance per line.
--
-- Balance model — exactly the one credit_balance is maintained by
-- (see 20260918110000 for the reconciliation formula):
--   + credit sale total_amount            (record_sale / add_item_to_sale)
--   − credit sale refunds                 (refund_sale, no floor)
--   − customer_payments.amount            (pay_customer_credit)
-- Cash and card sales are listed (SUMA Web's statement lists every sale
-- linked to the customer) but move the balance by 0.
--
-- Refund dating: refund_requests (since 20260925150000) holds one dated
-- row per refund_sale() call made with a client_request_id. Any refunded
-- amount not covered by those rows (older refunds, or calls without an id)
-- becomes one line at sales.refunded_at — the only timestamp that exists
-- for it. Either way the totals are exact; only the date of a legacy
-- multi-step refund is approximated to its last step.
--
-- Returns jsonb:
--   { customer, opening_balance, closing_balance, period_debit,
--     period_credit, recorded_balance, computed_balance, total_count,
--     rows: [ { kind, occurred_at, reference_id, payment_method, amount,
--               debit, credit, balance_after } ] }
-- rows are newest-first and paginated; balance_after is the running
-- balance over the customer's WHOLE history, so it stays correct on any
-- page and under any filter. opening_balance is the balance just before
-- _from. computed_balance (full history) vs recorded_balance
-- (customers.credit_balance) lets the UI flag drift instead of hiding it.
--
-- kinds: credit_sale, cash_sale, card_sale, refund, payment.

CREATE OR REPLACE FUNCTION public.get_customer_statement(
  _customer_id uuid,
  _store_id uuid,
  _from timestamptz DEFAULT NULL,
  _to timestamptz DEFAULT NULL,
  _kinds text[] DEFAULT NULL,
  _search text DEFAULT NULL,
  _limit integer DEFAULT 50,
  _offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _customer public.customers;
  _limit_c integer := LEAST(GREATEST(COALESCE(_limit, 50), 1), 500);
  _offset_c integer := GREATEST(COALESCE(_offset, 0), 0);
  _term text := NULLIF(lower(btrim(COALESCE(_search, ''))), '');
  _result jsonb;
BEGIN
  IF NOT (
    public.is_store_admin(_store_id)
    OR EXISTS (
      SELECT 1 FROM public.store_members m
      WHERE m.store_id = _store_id AND m.user_id = auth.uid() AND m.is_active AND m.can_manage_customers
    )
  ) THEN
    RAISE EXCEPTION 'ما عندكش صلاحية الاطلاع على حسابات الزبائن.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _customer FROM public.customers WHERE id = _customer_id AND store_id = _store_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الزبون غير موجود.';
  END IF;

  WITH sales_c AS (
    SELECT s.* FROM public.sales s
    WHERE s.customer_id = _customer_id AND s.store_id = _store_id
  ),
  refund_logged AS (
    SELECT rr.sale_id, rr.id, rr.created_at, rr.refund_total
    FROM public.refund_requests rr
    JOIN sales_c s ON s.id = rr.sale_id
    WHERE rr.refund_total > 0
  ),
  refund_rest AS (
    SELECT s.id AS sale_id,
           s.refunded_amount - COALESCE((SELECT sum(l.refund_total) FROM refund_logged l WHERE l.sale_id = s.id), 0) AS amount,
           COALESCE(s.refunded_at, s.occurred_at) AS at
    FROM sales_c s
    WHERE s.refunded_amount > 0
  ),
  events AS (
    SELECT (s.payment_method || '_sale')::text AS kind,
           s.occurred_at AS at,
           1 AS ord,
           s.id AS ref_id,
           s.id AS row_key,
           s.payment_method,
           s.total_amount::numeric AS amount,
           CASE WHEN s.payment_method = 'credit' THEN s.total_amount ELSE 0 END::numeric AS debit,
           0::numeric AS credit
    FROM sales_c s
    UNION ALL
    SELECT 'refund', l.created_at, 2, l.sale_id, l.id, s.payment_method, l.refund_total,
           0,
           CASE WHEN s.payment_method = 'credit' THEN l.refund_total ELSE 0 END
    FROM refund_logged l JOIN sales_c s ON s.id = l.sale_id
    UNION ALL
    SELECT 'refund', r.at, 2, r.sale_id, r.sale_id, s.payment_method, r.amount,
           0,
           CASE WHEN s.payment_method = 'credit' THEN r.amount ELSE 0 END
    FROM refund_rest r JOIN sales_c s ON s.id = r.sale_id
    WHERE r.amount > 0.004
    UNION ALL
    SELECT 'payment', p.created_at, 3, p.id, p.id, NULL, p.amount, 0, p.amount
    FROM public.customer_payments p
    WHERE p.customer_id = _customer_id AND p.store_id = _store_id
  ),
  running AS (
    SELECT e.*,
           sum(e.debit - e.credit) OVER (ORDER BY e.at, e.ord, e.row_key ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance_after
    FROM events e
  ),
  in_period AS (
    SELECT * FROM running r
    WHERE (_from IS NULL OR r.at >= _from)
      AND (_to IS NULL OR r.at <= _to)
  ),
  filtered AS (
    SELECT * FROM in_period r
    WHERE (_kinds IS NULL OR r.kind = ANY(_kinds))
      AND (_term IS NULL
           OR lower(r.ref_id::text) LIKE _term || '%'
           OR r.amount::text LIKE '%' || _term || '%')
  )
  SELECT jsonb_build_object(
    'customer', to_jsonb(_customer),
    'opening_balance', COALESCE((SELECT r.balance_after FROM running r WHERE _from IS NOT NULL AND r.at < _from
                                 ORDER BY r.at DESC, r.ord DESC, r.row_key DESC LIMIT 1), 0),
    'closing_balance', COALESCE((SELECT r.balance_after FROM running r WHERE _to IS NULL OR r.at <= _to
                                 ORDER BY r.at DESC, r.ord DESC, r.row_key DESC LIMIT 1), 0),
    'period_debit', COALESCE((SELECT sum(debit) FROM in_period), 0),
    'period_credit', COALESCE((SELECT sum(credit) FROM in_period), 0),
    'computed_balance', COALESCE((SELECT sum(debit - credit) FROM events), 0),
    'recorded_balance', _customer.credit_balance,
    'total_count', (SELECT count(*) FROM filtered),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'kind', f.kind,
               'occurred_at', f.at,
               'reference_id', f.ref_id,
               'payment_method', f.payment_method,
               'amount', f.amount,
               'debit', f.debit,
               'credit', f.credit,
               'balance_after', f.balance_after
             ) ORDER BY f.at DESC, f.ord DESC, f.row_key DESC)
      FROM (
        SELECT * FROM filtered
        ORDER BY at DESC, ord DESC, row_key DESC
        LIMIT _limit_c OFFSET _offset_c
      ) f
    ), '[]'::jsonb)
  ) INTO _result;

  RETURN _result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_customer_statement(uuid, uuid, timestamptz, timestamptz, text[], text, integer, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_statement(uuid, uuid, timestamptz, timestamptz, text[], text, integer, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
