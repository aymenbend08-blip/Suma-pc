-- import_products: batched, validated product import (Excel/CSV).
--
-- SUMA Web's import sends one HTTP request per chunk but then writes each
-- row with its own insert/update round trip, overwrites existing fields
-- with NULL whenever a cell is blank, writes stock as an absolute value
-- with no stock_movements row, and only detects duplicates by primary
-- barcode (so re-importing a file whose rows have no barcode creates
-- duplicates). This function is the database-side version SUMA PC uses:
--
--   * one call per chunk (≤ 1000 rows), one transaction; each row runs in
--     its own sub-transaction so a bad row is reported, not fatal;
--   * _dry_run = true runs every check and returns the same per-row
--     verdicts without writing anything — that is the preview;
--   * duplicate detection: main barcode → extra barcode → variant barcode
--     → internal_code → (only when the row has neither barcode nor code)
--     an exact, case-insensitive name match that must be unique;
--   * updates only touch fields the row actually provides;
--   * stock changes go through the ledger (reason 'manual', reference_type
--     'import') as a delta computed under a row lock;
--   * server-side validation: name, barcode charset/length (same rule as
--     SUMA Web's barcode schema), non-negative prices, stock bounds;
--   * permissions mirror the table's RLS exactly, since SECURITY DEFINER
--     bypasses it: creating products and categories needs is_store_admin
--     (products_admin_insert / cat_write); updating an existing product is
--     also open to can_manage_products (products_update); a price change
--     stays owner-only (checked up front for a readable per-row error, and
--     still enforced by trg_products_price_owner_only);
--   * extra barcodes are attached per barcode; a conflicting one becomes a
--     warning, never a row failure (cross-table uniqueness is enforced by
--     the 20260926100000 trigger).
--
-- _duplicate_strategy: 'update' (default) | 'skip' | 'barcode_only'
--   (only attach new extra barcodes to the matched product).
--
-- Row shape (all optional except name):
--   { row, name, barcode, extra_barcodes: [..], internal_code,
--     selling_price, purchase_price, stock_quantity, unit, category_name,
--     low_stock_threshold, points_reward, expiry_date, description }
--
-- Returns { dry_run, created, updated, skipped, barcode_only, failed,
--           results: [{row, name, status, product_id, matched_by, reason}],
--           warnings: [{row, note}] }

CREATE INDEX IF NOT EXISTS idx_products_store_lower_name
  ON public.products (store_id, lower(btrim(name)));

CREATE OR REPLACE FUNCTION public.import_products(
  _store_id uuid,
  _rows jsonb,
  _duplicate_strategy text DEFAULT 'update',
  _dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _is_admin boolean := public.is_store_admin(_store_id);
  _is_owner boolean := EXISTS (SELECT 1 FROM public.stores s WHERE s.id = _store_id AND s.owner_id = auth.uid());
  _can_update boolean;
  _row jsonb;
  _i integer := 0;
  _line integer;
  _name text;
  _barcode text;
  _internal text;
  _unit text;
  _cat_name text;
  _desc text;
  _selling numeric;
  _purchase numeric;
  _stock numeric;
  _low numeric;
  _points integer;
  _expiry date;
  _extras text[];
  _extra text;
  _raw_extra jsonb;
  _match public.products;
  _matched_by text;
  _cnt integer;
  _cat_id uuid;
  _pid uuid;
  _before numeric;
  _delta numeric;
  _added integer;
  _seen text[] := '{}';
  _status text;
  _created integer := 0;
  _updated integer := 0;
  _skipped integer := 0;
  _barcode_only integer := 0;
  _failed integer := 0;
  _results jsonb := '[]'::jsonb;
  _warnings jsonb := '[]'::jsonb;
  _constraint text;
  _msg text;
BEGIN
  _can_update := _is_admin OR EXISTS (
    SELECT 1 FROM public.store_members m
    WHERE m.store_id = _store_id AND m.user_id = auth.uid() AND m.is_active AND m.can_manage_products
  );
  IF NOT _can_update THEN
    RAISE EXCEPTION 'ما عندكش صلاحية استيراد المنتجات.' USING ERRCODE = '42501';
  END IF;
  IF _duplicate_strategy NOT IN ('update', 'skip', 'barcode_only') THEN
    RAISE EXCEPTION 'طريقة معالجة المكرر غير صالحة.';
  END IF;
  IF jsonb_typeof(_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(_rows) = 0 THEN
    RAISE EXCEPTION 'لا توجد صفوف للاستيراد.';
  END IF;
  IF jsonb_array_length(_rows) > 1000 THEN
    RAISE EXCEPTION 'أقصى عدد في الدفعة الواحدة 1000 صف.';
  END IF;

  FOR _row IN SELECT value FROM jsonb_array_elements(_rows) LOOP
    _i := _i + 1;
    _line := CASE WHEN jsonb_typeof(_row->'row') = 'number' THEN (_row->>'row')::integer ELSE _i END;
    _name := NULLIF(btrim(COALESCE(_row->>'name', '')), '');
    _pid := NULL;
    _matched_by := NULL;
    _status := NULL;

    BEGIN
      -- ---------- validation
      IF _name IS NULL THEN
        RAISE EXCEPTION 'بدون اسم منتج.';
      END IF;
      IF length(_name) > 160 THEN
        RAISE EXCEPTION 'اسم المنتج أطول من 160 حرف.';
      END IF;

      _barcode := NULLIF(btrim(COALESCE(_row->>'barcode', '')), '');
      IF _barcode IS NOT NULL AND (length(_barcode) > 64 OR _barcode !~ '^[A-Za-z0-9_-]+$') THEN
        RAISE EXCEPTION 'باركود غير صالح: % (حروف وأرقام و - _ فقط، 64 حرف كحد أقصى).', _barcode;
      END IF;

      _internal := NULLIF(btrim(COALESCE(_row->>'internal_code', '')), '');
      IF _internal IS NOT NULL AND length(_internal) > 40 THEN
        RAISE EXCEPTION 'الكود الداخلي أطول من 40 حرف.';
      END IF;
      _unit := NULLIF(btrim(COALESCE(_row->>'unit', '')), '');
      IF _unit IS NOT NULL AND length(_unit) > 30 THEN
        RAISE EXCEPTION 'الوحدة أطول من 30 حرف.';
      END IF;
      _cat_name := NULLIF(btrim(COALESCE(_row->>'category_name', '')), '');
      IF _cat_name IS NOT NULL AND length(_cat_name) > 80 THEN
        RAISE EXCEPTION 'اسم التصنيف أطول من 80 حرف.';
      END IF;
      _desc := NULLIF(btrim(COALESCE(_row->>'description', '')), '');
      IF _desc IS NOT NULL AND length(_desc) > 1000 THEN
        RAISE EXCEPTION 'الوصف أطول من 1000 حرف.';
      END IF;

      _selling := NULLIF(_row->>'selling_price', '')::numeric;
      IF _selling IS NOT NULL AND (_selling < 0 OR _selling > 99999999) THEN
        RAISE EXCEPTION 'سعر البيع غير صالح.';
      END IF;
      _purchase := NULLIF(_row->>'purchase_price', '')::numeric;
      IF _purchase IS NOT NULL AND (_purchase < 0 OR _purchase > 99999999) THEN
        RAISE EXCEPTION 'سعر الشراء غير صالح.';
      END IF;
      _stock := NULLIF(_row->>'stock_quantity', '')::numeric;
      IF _stock IS NOT NULL AND (_stock < -99999 OR _stock > 9999999) THEN
        RAISE EXCEPTION 'الكمية غير صالحة.';
      END IF;
      _low := NULLIF(_row->>'low_stock_threshold', '')::numeric;
      IF _low IS NOT NULL AND (_low < 0 OR _low > 999999) THEN
        RAISE EXCEPTION 'حد المخزون الأدنى غير صالح.';
      END IF;
      _points := NULLIF(_row->>'points_reward', '')::numeric::integer;
      IF _points IS NOT NULL AND (_points < 0 OR _points > 10000) THEN
        RAISE EXCEPTION 'نقاط الولاء لازم تكون بين 0 و10000.';
      END IF;
      _expiry := NULLIF(btrim(COALESCE(_row->>'expiry_date', '')), '')::date;

      _extras := '{}';
      IF jsonb_typeof(_row->'extra_barcodes') = 'array' THEN
        FOR _raw_extra IN SELECT value FROM jsonb_array_elements(_row->'extra_barcodes') LOOP
          _extra := NULLIF(btrim(COALESCE(_raw_extra #>> '{}', '')), '');
          CONTINUE WHEN _extra IS NULL;
          IF length(_extra) > 64 OR _extra !~ '^[A-Za-z0-9_-]+$' THEN
            _warnings := _warnings || jsonb_build_object('row', _line, 'note', 'باركود إضافي غير صالح تم تجاهله: ' || _extra);
            CONTINUE;
          END IF;
          CONTINUE WHEN _extra = _barcode OR _extra = ANY(_extras);
          _extras := _extras || _extra;
        END LOOP;
      END IF;
      IF array_length(_extras, 1) > 30 THEN
        RAISE EXCEPTION 'أكثر من 30 باركود إضافي في صف واحد.';
      END IF;

      IF _barcode IS NOT NULL AND _barcode = ANY(_seen) THEN
        RAISE EXCEPTION 'باركود مكرر داخل نفس الملف: %.', _barcode;
      END IF;

      -- ---------- duplicate detection
      _match := NULL;
      IF _barcode IS NOT NULL THEN
        SELECT * INTO _match FROM public.products WHERE store_id = _store_id AND barcode = _barcode;
        IF FOUND THEN
          _matched_by := 'barcode';
        ELSE
          SELECT p.* INTO _match FROM public.product_barcodes b
          JOIN public.products p ON p.id = b.product_id
          WHERE b.store_id = _store_id AND b.barcode = _barcode;
          IF FOUND THEN
            _matched_by := 'extra_barcode';
          ELSE
            SELECT p.* INTO _match FROM public.product_variants v
            JOIN public.products p ON p.id = v.product_id
            WHERE v.store_id = _store_id AND v.barcode = _barcode;
            IF FOUND THEN
              _matched_by := 'variant_barcode';
            END IF;
          END IF;
        END IF;
      END IF;
      IF _match.id IS NULL AND _internal IS NOT NULL THEN
        SELECT * INTO _match FROM public.products WHERE store_id = _store_id AND internal_code = _internal;
        IF FOUND THEN
          _matched_by := 'internal_code';
        END IF;
      END IF;
      IF _match.id IS NULL AND _barcode IS NULL AND _internal IS NULL THEN
        SELECT count(*) INTO _cnt FROM public.products
        WHERE store_id = _store_id AND lower(btrim(name)) = lower(_name);
        IF _cnt = 1 THEN
          SELECT * INTO _match FROM public.products
          WHERE store_id = _store_id AND lower(btrim(name)) = lower(_name);
          _matched_by := 'name';
        ELSIF _cnt > 1 THEN
          RAISE EXCEPTION 'يوجد أكثر من منتج بنفس الاسم — أضف باركود أو كود داخلي للتمييز.';
        END IF;
      END IF;

      -- ---------- category
      _cat_id := NULL;
      IF _cat_name IS NOT NULL AND (_match.id IS NULL OR (_duplicate_strategy = 'update' AND _matched_by <> 'variant_barcode')) THEN
        SELECT c.id INTO _cat_id FROM public.categories c
        WHERE c.store_id = _store_id AND lower(btrim(c.name)) = lower(_cat_name)
        ORDER BY c.created_at LIMIT 1;
        IF _cat_id IS NULL THEN
          IF _is_admin THEN
            IF NOT _dry_run THEN
              INSERT INTO public.categories (store_id, name) VALUES (_store_id, _cat_name) RETURNING id INTO _cat_id;
            END IF;
            _warnings := _warnings || jsonb_build_object('row', _line, 'note', 'تصنيف جديد: ' || _cat_name);
          ELSE
            _warnings := _warnings || jsonb_build_object('row', _line,
              'note', 'التصنيف «' || _cat_name || '» غير موجود وإنشاؤه محجوز للمدير — تُرك بلا تغيير.');
          END IF;
        END IF;
      END IF;

      IF _match.id IS NULL THEN
        -- ---------- new product
        IF NOT _is_admin THEN
          RAISE EXCEPTION 'إضافة منتجات جديدة محجوزة لصاحب المحل والمدير.' USING ERRCODE = '42501';
        END IF;
        IF NOT _dry_run THEN
          INSERT INTO public.products
            (store_id, name, barcode, internal_code, selling_price, purchase_price, stock_quantity, unit,
             category_id, low_stock_threshold, points_reward, expiry_date, description, is_active)
          VALUES
            (_store_id, _name, _barcode, _internal, _selling, _purchase, COALESCE(_stock, 0), COALESCE(_unit, 'وحدة'),
             _cat_id, COALESCE(_low, 5), COALESCE(_points, 0), _expiry, _desc, true)
          RETURNING id INTO _pid;
          IF COALESCE(_stock, 0) <> 0 THEN
            INSERT INTO public.stock_movements
              (store_id, product_id, product_name, delta, quantity_before, quantity_after, reason, reference_type, notes, created_by)
            VALUES
              (_store_id, _pid, _name, _stock, 0, _stock, 'manual', 'import', 'استيراد Excel — مخزون أولي', auth.uid());
          END IF;
        END IF;
        IF _selling IS NULL THEN
          _warnings := _warnings || jsonb_build_object('row', _line, 'note', 'بدون سعر بيع — لن يُباع حتى يُحدَّد سعره.');
        END IF;
        _status := 'created';
        _created := _created + 1;
      ELSIF _duplicate_strategy = 'skip' OR _matched_by = 'variant_barcode' THEN
        _pid := _match.id;
        _status := 'skipped';
        _skipped := _skipped + 1;
        IF _matched_by = 'variant_barcode' THEN
          _warnings := _warnings || jsonb_build_object('row', _line,
            'note', 'الباركود ' || _barcode || ' يخص تنويعة للمنتج «' || _match.name || '» — تم تجاهل الصف لتفادي تعديل المنتج الأساسي.');
        END IF;
      ELSE
        _pid := _match.id;
        IF _duplicate_strategy = 'update' THEN
          IF _selling IS NOT NULL AND _selling IS DISTINCT FROM _match.selling_price AND NOT _is_owner THEN
            RAISE EXCEPTION 'تغيير السعر محجوز لصاحب المحل فقط (السعر الحالي %).', COALESCE(_match.selling_price::text, 'بدون');
          END IF;
          IF NOT _dry_run THEN
            UPDATE public.products SET
              name = _name,
              barcode = CASE
                WHEN barcode IS NULL AND _barcode IS NOT NULL AND _matched_by IN ('internal_code', 'name') THEN _barcode
                ELSE barcode END,
              internal_code = COALESCE(_internal, internal_code),
              selling_price = COALESCE(_selling, selling_price),
              purchase_price = COALESCE(_purchase, purchase_price),
              unit = COALESCE(_unit, unit),
              category_id = COALESCE(_cat_id, category_id),
              low_stock_threshold = COALESCE(_low, low_stock_threshold),
              points_reward = COALESCE(_points, points_reward),
              expiry_date = COALESCE(_expiry, expiry_date),
              description = COALESCE(_desc, description)
            WHERE id = _pid;

            IF _stock IS NOT NULL THEN
              SELECT stock_quantity INTO _before FROM public.products WHERE id = _pid FOR UPDATE;
              _delta := _stock - _before;
              IF _delta <> 0 THEN
                UPDATE public.products SET stock_quantity = _stock WHERE id = _pid;
                INSERT INTO public.stock_movements
                  (store_id, product_id, product_name, delta, quantity_before, quantity_after, reason, reference_type, notes, created_by)
                VALUES
                  (_store_id, _pid, _name, _delta, _before, _stock, 'manual', 'import', 'استيراد Excel', auth.uid());
              END IF;
            END IF;
          END IF;
          -- A file barcode that differs from the product's main one, when the
          -- row was matched some other way, is kept as an extra barcode.
          IF _barcode IS NOT NULL AND _matched_by IN ('internal_code', 'name')
             AND _match.barcode IS NOT NULL AND _match.barcode <> _barcode
             AND NOT (_barcode = ANY(_extras)) THEN
            _extras := _extras || _barcode;
          END IF;
          _status := 'updated';
          _updated := _updated + 1;
        ELSE
          _status := 'barcode_only';
        END IF;
      END IF;

      -- ---------- extra barcodes
      _added := 0;
      IF _status <> 'skipped' THEN
        FOREACH _extra IN ARRAY _extras LOOP
          IF _pid IS NOT NULL AND (
               EXISTS (SELECT 1 FROM public.products WHERE id = _pid AND barcode = _extra)
               OR EXISTS (SELECT 1 FROM public.product_barcodes WHERE product_id = _pid AND barcode = _extra)
             ) THEN
            CONTINUE;
          END IF;
          IF _dry_run THEN
            IF EXISTS (SELECT 1 FROM public.products WHERE store_id = _store_id AND barcode = _extra)
               OR EXISTS (SELECT 1 FROM public.product_barcodes WHERE store_id = _store_id AND barcode = _extra)
               OR EXISTS (SELECT 1 FROM public.product_variants WHERE store_id = _store_id AND barcode = _extra) THEN
              _warnings := _warnings || jsonb_build_object('row', _line, 'note', 'الباركود الإضافي ' || _extra || ' مستخدم لمنتج آخر — سيتم تجاهله.');
            ELSE
              _added := _added + 1;
            END IF;
          ELSE
            BEGIN
              INSERT INTO public.product_barcodes (product_id, store_id, barcode) VALUES (_pid, _store_id, _extra);
              _added := _added + 1;
            EXCEPTION WHEN unique_violation THEN
              _warnings := _warnings || jsonb_build_object('row', _line, 'note', 'الباركود الإضافي ' || _extra || ' مستخدم لمنتج آخر — تم تجاهله.');
            END;
          END IF;
        END LOOP;
      END IF;

      IF _status = 'barcode_only' THEN
        IF _added > 0 THEN
          _barcode_only := _barcode_only + 1;
        ELSE
          _status := 'skipped';
          _skipped := _skipped + 1;
        END IF;
      END IF;

      IF _barcode IS NOT NULL THEN
        _seen := _seen || _barcode;
      END IF;

      _results := _results || jsonb_build_object(
        'row', _line, 'name', _name, 'status', _status, 'product_id', _pid, 'matched_by', _matched_by);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS _constraint = CONSTRAINT_NAME, _msg = MESSAGE_TEXT;
      _msg := CASE
        WHEN _constraint IN ('uq_products_store_barcode', 'uq_product_barcodes_store_barcode', 'uq_variants_store_barcode', 'uq_store_barcode_any')
          THEN 'الباركود مستعمل من قبل في محلك.'
        WHEN _constraint = 'uq_products_store_internal' THEN 'الكود الداخلي مستعمل من قبل لمنتج آخر في محلك.'
        WHEN SQLSTATE = '22P02' OR SQLSTATE = '22007' OR SQLSTATE = '22008' THEN 'قيمة رقمية أو تاريخ غير صالح في هذا الصف.'
        ELSE _msg
      END;
      _failed := _failed + 1;
      _results := _results || jsonb_build_object('row', _line, 'name', _name, 'status', 'error', 'reason', _msg);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'dry_run', _dry_run,
    'created', _created,
    'updated', _updated,
    'skipped', _skipped,
    'barcode_only', _barcode_only,
    'failed', _failed,
    'results', _results,
    'warnings', _warnings
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_products(uuid, jsonb, text, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.import_products(uuid, jsonb, text, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';
