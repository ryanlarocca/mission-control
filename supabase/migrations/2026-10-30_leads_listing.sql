-- Listing status (Ryan 2026-10-30): is the lead's property on the market
-- right now? Stamped cluster-wide by scripts/listing-status.py from the
-- public MLSListings search (plain HTTP, no login). Null = never checked.
-- Shape: {"status":"Active"|"Pending"|"Active Under Contract"|"not_listed",
--         "price":2845000,"dom":69,"type":"Single Family Residence",
--         "mls":"ML82039706","url":"https://www.mlslistings.com/property/…",
--         "source":"mlslistings","checked_at":"2026-10-30T…"}
-- The card shows an ON MARKET chip for Active / Pending / AUC and Follow Ups
-- sorts those rows last — Ryan calls listed owners last.
alter table leads add column if not exists listing jsonb;
comment on column leads.listing is 'MLS listing status for property_address: {status, price, dom, type, mls, url, source, checked_at}. Null = never checked; status "not_listed" = checked, nothing active/pending.';
