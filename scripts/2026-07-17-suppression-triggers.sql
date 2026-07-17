-- Write-through triggers for the master suppression list (2026-07-17).
--
-- Rationale: is_dnc gets set from 4+ code sites (manual DNC route, SMS STOP
-- webhook, AI auto-DNC in lib/leads.ts, drip-engine hard stop) and future
-- sites will appear. A trigger at the data layer catches every path forever —
-- the "silent failure" class this codebase keeps getting bitten by. App code
-- never needs to remember suppression exists on the lead-DNC side.
--
-- Symmetry: un-DNC (is_dnc true→false, dnc_list row deleted) removes the
-- matching suppression row, so Ryan changing his mind propagates too.

create or replace function suppression_sync_from_lead() returns trigger
language plpgsql as $$
begin
  if new.is_dnc = true and (tg_op = 'INSERT' or coalesce(old.is_dnc, false) = false) then
    insert into suppression
      (email, phone, name, site_address, reason, source, source_ref, channel, audience)
    values (
      lower(nullif(trim(new.email), '')),
      nullif(right(regexp_replace(coalesce(new.caller_phone, ''), '\D', '', 'g'), 10), ''),
      new.name,
      new.property_address,
      'lead marked DNC in Mission Control',
      'lead_dnc',
      new.id::text,
      'all',
      'seller'
    )
    on conflict (source, source_ref) where source_ref is not null do nothing;
  elsif tg_op = 'UPDATE' and coalesce(old.is_dnc, false) = true and new.is_dnc = false then
    delete from suppression where source = 'lead_dnc' and source_ref = new.id::text;
  end if;
  return new;
end $$;

drop trigger if exists trg_suppression_sync_lead on leads;
create trigger trg_suppression_sync_lead
  after insert or update of is_dnc on leads
  for each row execute function suppression_sync_from_lead();

create or replace function suppression_sync_from_dnc_list() returns trigger
language plpgsql as $$
declare
  l record;
begin
  if tg_op = 'INSERT' then
    select email, caller_phone into l from leads where id = new.source_lead_id;
    insert into suppression
      (email, phone, name, parcel_number, site_address, site_city, site_state, site_zip,
       mail_address, mail_city, mail_state, mail_zip, county, reason, source, source_ref,
       channel, audience)
    values (
      lower(nullif(trim(l.email), '')),
      nullif(right(regexp_replace(coalesce(l.caller_phone, ''), '\D', '', 'g'), 10), ''),
      new.owner_name,
      new.parcel_number, new.site_address, new.site_city, new.site_state, new.site_zip,
      new.mail_address, new.mail_city, new.mail_state, new.mail_zip, new.county,
      coalesce(new.reason, 'dnc_list entry'),
      'dnc_list',
      new.id::text,
      'all',
      'seller'
    )
    on conflict (source, source_ref) where source_ref is not null do nothing;
    return new;
  elsif tg_op = 'DELETE' then
    delete from suppression where source = 'dnc_list' and source_ref = old.id::text;
    return old;
  end if;
  return new;
end $$;

drop trigger if exists trg_suppression_sync_dnc_list on dnc_list;
create trigger trg_suppression_sync_dnc_list
  after insert or delete on dnc_list
  for each row execute function suppression_sync_from_dnc_list();
