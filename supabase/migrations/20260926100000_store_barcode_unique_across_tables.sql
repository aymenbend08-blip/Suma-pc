-- Barcode uniqueness across products / product_barcodes / product_variants.
--
-- Each of the three tables already has its own per-store unique index
-- (uq_products_store_barcode, uq_product_barcodes_store_barcode,
-- uq_variants_store_barcode), but nothing stopped the SAME code from living
-- in two different tables of one store — e.g. a variant barcode equal to
-- another product's main barcode. A scanner would then resolve to whichever
-- lookup path happens to run first. SUMA Web guards this in app code only
-- (variants.functions.ts assertBarcodeFree — "Postgres can't express that
-- as one constraint across two tables"); SUMA PC writes directly under RLS,
-- so the rule has to live in the database to hold for every client.
--
-- A trigger can express it. An advisory lock keyed on (store, code)
-- serializes two concurrent claims of the same code into different tables,
-- which a plain "SELECT then INSERT" check would let through.
--
-- Checked before deploy: zero existing cross-table duplicates, so this
-- blocks nothing that already exists. Only fires when the barcode (or
-- store) actually changes on UPDATE, so unrelated edits are unaffected.

CREATE OR REPLACE FUNCTION public.enforce_store_barcode_unique()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _code text := NULLIF(btrim(NEW.barcode), '');
BEGIN
  IF _code IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.barcode IS NOT DISTINCT FROM OLD.barcode
     AND NEW.store_id = OLD.store_id THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.store_id::text || '|' || _code, 0));

  IF TG_TABLE_NAME <> 'products' AND EXISTS (
    SELECT 1 FROM public.products WHERE store_id = NEW.store_id AND barcode = _code
  ) THEN
    RAISE EXCEPTION 'هذا الباركود مستعمل أصلاً لمنتج في محلك.'
      USING ERRCODE = '23505', CONSTRAINT = 'uq_store_barcode_any';
  END IF;

  IF TG_TABLE_NAME <> 'product_barcodes' AND EXISTS (
    SELECT 1 FROM public.product_barcodes WHERE store_id = NEW.store_id AND barcode = _code
  ) THEN
    RAISE EXCEPTION 'هذا الباركود مستعمل أصلاً كباركود إضافي لمنتج في محلك.'
      USING ERRCODE = '23505', CONSTRAINT = 'uq_store_barcode_any';
  END IF;

  IF TG_TABLE_NAME <> 'product_variants' AND EXISTS (
    SELECT 1 FROM public.product_variants WHERE store_id = NEW.store_id AND barcode = _code
  ) THEN
    RAISE EXCEPTION 'هذا الباركود مستعمل أصلاً لتنويعة في محلك.'
      USING ERRCODE = '23505', CONSTRAINT = 'uq_store_barcode_any';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_barcode_unique_any ON public.products;
CREATE TRIGGER trg_products_barcode_unique_any
  BEFORE INSERT OR UPDATE OF barcode, store_id ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.enforce_store_barcode_unique();

DROP TRIGGER IF EXISTS trg_product_barcodes_barcode_unique_any ON public.product_barcodes;
CREATE TRIGGER trg_product_barcodes_barcode_unique_any
  BEFORE INSERT OR UPDATE OF barcode, store_id ON public.product_barcodes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_store_barcode_unique();

DROP TRIGGER IF EXISTS trg_variants_barcode_unique_any ON public.product_variants;
CREATE TRIGGER trg_variants_barcode_unique_any
  BEFORE INSERT OR UPDATE OF barcode, store_id ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_store_barcode_unique();
