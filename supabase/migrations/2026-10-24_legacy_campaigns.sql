-- Legacy mailings (Ryan 2026-10-24: "create a legacy tab for this").
-- Every direct-mail drop before the system tracked campaigns (Nov 2021 →
-- Feb 2026), from the ITI invoice audit (pieces + invoice totals) and the
-- mailing-history inventory (PROJECTS/lead-pipeline/research/2026-10-24_*).
-- campaigns.legacy keeps them on the Legacy tab of Campaign Performance and
-- out of the current-campaign cards. Old closes are re-attributed here so
-- "MFM-A May 2026" no longer carries Kirkland (closed 2025) or Quito.
alter table campaigns add column if not exists legacy boolean not null default false;
alter table campaigns add column if not exists order_number text;
comment on column campaigns.legacy is 'Historical mailing entered after the fact (invoice data); shown on the Legacy tab only.';
comment on column campaigns.order_number is 'Mail-house order / invoice number (ITI).';

insert into campaigns (name, channel, drop_date, pieces_sent, total_cost, notes, legacy, order_number)
select v.name, 'direct_mail', v.drop_date::date, v.pieces, v.cost, v.notes, true, v.ord
from (values
  ('Nov 2021 double mailer (multifamily + SCV SFR)', '2021-12-10', 11166, 6184.91, 'Two lists: Multi-Family List (4,581) + SCV SFR 6493 (6,585).', '95875'),
  ('Jan 2022 South Bay large-home fixers', '2022-02-01', 6878, 3921.51, 'South Bay large homes $2-5M, fixers. Color.', '97081'),
  ('Feb 2022 multifamily', '2022-02-11', 4180, 2295.79, 'Multi-Family List clipped. $208.89 store credit promised, never applied.', '97357'),
  ('Mar 2022 SMC residential', '2022-04-08', 7188, 4118.21, 'San Mateo Co large homes owned since 1994. Color.', '98224'),
  ('Apr 2022 South Bay re-mail', '2022-04-28', 6878, 4093.49, 'Re-mail of the Jan 2022 list. Color.', '99194'),
  ('Apr 2022 MFM April', '2022-04-28', 4123, 2489.88, 'Multifamily, government/LLC/corp owners removed. Color.', '99195'),
  ('Jun 2022 SMC residential re-mail', '2022-06-14', 7186, 4193.92, 'Re-mail of the Mar 2022 list ("RM April"). Color.', '100032'),
  ('Jan 2023 SCV fixers', '2023-01-28', 5639, 3671.94, 'Santa Clara Co fixer list. Color.', '214654'),
  ('Apr 2023 San Jose trusts', '2023-04-20', 4001, 2340.14, 'San Jose trust-owned since 1990 (PropertyRadar). B&W.', '216809'),
  ('Aug 2023 EDDM postcards (95118)', '2023-08-11', 450, null, 'USPS Every Door Direct Mail, Robertsville PO carrier routes; printed by REPS. No address list exists. Cost not on file.', 'EDDM 8755272'),
  ('Nov 2023 SVEP flyers (Farm A + B)', '2023-11-17', 12373, 7623.96, 'Flyers to Farm A (408) + Farm B (650), two drops. Color.', '221920'),
  ('Dec 2023 SVEP letter (Farm A + B)', '2023-12-20', 12373, 7348.54, 'Follow-up letter to the same farms, 4 batches. B&W.', '222515'),
  ('Feb 2025 MFM1 yellow letter (SMC+SCC combined farm)', '2025-03-07', 10357, 6923.95, 'Combined multifamily farm 10.3k, line 408-365-4925.', '231907'),
  ('Jun 2025 MFM2 yellow letter re-mail', '2025-06-27', 10355, 6518.37, 'Re-mail of the Feb 2025 combined farm.', '234340'),
  ('Jul 2025 SVR yellow letter (19k NOO SCC)', '2025-07-25', 19002, 11635.39, 'SCC SFR non-owner-occupied, owned since 2008.', '234837'),
  ('Sep 2025 farm letters SVA-SVD', '2025-10-01', 16289, 10714.58, 'Four versions: Owner 80+ (SVA), DOTJ (SVB), deceased free & clear (SVC), out of county (SVD). Billed for 17,537; 1,248 dupes removed, $764.15 credit applied on #237271.', '236237'),
  ('Nov 2025 Tri County multifamily A', '2025-11-25', 8646, 4578.31, 'SCC/SMC/Santa Cruz multifamily since 2015, yellow letter.', '237271'),
  ('Nov 2025 Tri County multifamily B (snap pack)', '2025-11-25', 5869, 3371.41, 'Same farm, snap pack.', '237273'),
  ('Feb 2026 SVR yellow letter (SVA owner-occ + SVB NOO)', '2026-02-18', 20867, 13287.72, 'SVA = SCC SFR owner-occupied (10,655), SVB = SCC+SMC SFR NOO (10,212). Line 408-357-3440.', '238880')
) as v(name, drop_date, pieces, cost, notes, ord)
where not exists (select 1 from campaigns c where c.order_number = v.ord);
