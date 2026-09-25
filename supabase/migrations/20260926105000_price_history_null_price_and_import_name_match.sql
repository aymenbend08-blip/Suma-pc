-- 1) log_price_change(): products.selling_price has been nullable since
--    20260910104631, but this trigger always wrote NEW.selling_price into
--    price_history.new_price, which is NOT NULL. Any product insert without
--    a price (e.g. an import row with no price) or any update that clears
--    the price failed with a raw 23502. There is no price to record in that
--    case, so the history row is skipped; the next real price is logged as
--    usual (old_price NULL → new price).
--
-- 2) import_products(): a row matched to an existing product by
--    case-insensitive NAME no longer rewrites that product's name to the
--    file's spelling (e.g. "Lait Candia" → "lait candia"). Rows matched by
--    barcode / internal code still update the name, as SUMA Web's import does.
--    Patched in place so the rest of the 20260926104000 body stays identical.

CREATE OR REPLACE FUNCTION public.log_price_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.selling_price IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.price_history(product_id, store_id, old_price, new_price, changed_by, source)
    VALUES (NEW.id, NEW.store_id, NULL, NEW.selling_price, auth.uid(), 'manual');
  ELSIF NEW.selling_price IS DISTINCT FROM OLD.selling_price THEN
    INSERT INTO public.price_history(product_id, store_id, old_price, new_price, changed_by, source)
    VALUES (NEW.id, NEW.store_id, OLD.selling_price, NEW.selling_price, auth.uid(),
      CASE WHEN NEW.source = 'connector' THEN 'connector'::public.price_change_source ELSE 'manual'::public.price_change_source END);
  END IF;
  RETURN NEW;
END; $function$;

DO $$
DECLARE
  _def text := pg_get_functiondef('public.import_products(uuid,jsonb,text,boolean)'::regprocedure);
  _patched text;
BEGIN
  _patched := replace(_def, 'name = _name,', 'name = CASE WHEN _matched_by = ''name'' THEN name ELSE _name END,');
  IF _patched = _def THEN
    RAISE EXCEPTION 'import_products patch target not found';
  END IF;
  EXECUTE _patched;
END $$;

NOTIFY pgrst, 'reload schema';
