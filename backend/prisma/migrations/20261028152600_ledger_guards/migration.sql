-- Hard ledger guards. Counters are maintained by application transactions; these
-- constraints make an inconsistent commit impossible, not just discouraged.

ALTER TABLE "products"
  ADD CONSTRAINT "products_ledger_bounds_check"
  CHECK (
    "initialStock" >= 0
    AND "reservedStock" >= 0
    AND "soldStock" >= 0
    AND "reservedStock" + "soldStock" <= "initialStock"
  );

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_quantity_check"
  CHECK ("quantity" = 1);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_quantity_check"
  CHECK ("quantity" = 1);

CREATE OR REPLACE FUNCTION "flashsale_assert_ledger"() RETURNS trigger AS $$
DECLARE
  pid text;
  p record;
  active_rows integer;
  confirmed_rows integer;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    pid := COALESCE(NEW."id", OLD."id");
  ELSE
    pid := COALESCE(NEW."productId", OLD."productId");
  END IF;

  SELECT * INTO p FROM "products" WHERE "id" = pid;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*) INTO active_rows
    FROM "reservations"
    WHERE "productId" = pid AND "status" = 'ACTIVE';

  SELECT COUNT(*) INTO confirmed_rows
    FROM "orders"
    WHERE "productId" = pid AND "status" = 'CONFIRMED';

  IF p."reservedStock" <> active_rows OR p."soldStock" <> confirmed_rows THEN
    RAISE EXCEPTION
      'inventory ledger mismatch for %: reserved counter %, active rows %, sold counter %, confirmed rows %',
      pid, p."reservedStock", active_rows, p."soldStock", confirmed_rows;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Deferred so a transaction may update the counter and its reservation/order in
-- either order. The invariant is checked at COMMIT, which is the consistency
-- boundary for the PostgreSQL ledger.
CREATE CONSTRAINT TRIGGER "products_ledger_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "products"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "flashsale_assert_ledger"();

CREATE CONSTRAINT TRIGGER "reservations_ledger_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "reservations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "flashsale_assert_ledger"();

CREATE CONSTRAINT TRIGGER "orders_ledger_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "orders"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "flashsale_assert_ledger"();
