-- The original guard read the product counters and the independent row counts in
-- three separate statements. Under READ COMMITTED each statement gets a new
-- snapshot, so a concurrent commit landing between them could make a perfectly
-- consistent transaction look inconsistent. Read the counters and both counts in
-- one statement so the guard evaluates a single MVCC snapshot.
CREATE OR REPLACE FUNCTION "flashsale_assert_ledger"() RETURNS trigger AS $$
DECLARE
  pid text;
  reserved_counter integer;
  sold_counter integer;
  active_rows integer;
  confirmed_rows integer;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    pid := COALESCE(NEW."id", OLD."id");
  ELSE
    pid := COALESCE(NEW."productId", OLD."productId");
  END IF;

  SELECT
    p."reservedStock",
    p."soldStock",
    (SELECT COUNT(*) FROM "reservations" r
      WHERE r."productId" = pid AND r."status" = 'ACTIVE'),
    (SELECT COUNT(*) FROM "orders" o
      WHERE o."productId" = pid AND o."status" = 'CONFIRMED')
  INTO reserved_counter, sold_counter, active_rows, confirmed_rows
  FROM "products" p
  WHERE p."id" = pid;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF reserved_counter <> active_rows OR sold_counter <> confirmed_rows THEN
    RAISE EXCEPTION
      'inventory ledger mismatch for %: reserved counter %, active rows %, sold counter %, confirmed rows %',
      pid, reserved_counter, active_rows, sold_counter, confirmed_rows;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
