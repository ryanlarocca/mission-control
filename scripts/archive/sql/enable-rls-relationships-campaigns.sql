-- Security fix: enable Row-Level Security on tables that were publicly accessible.
--
-- Supabase flagged campaigns, relationships, and relationship_touches as
-- "Table publicly accessible" (lint: rls_disabled_in_public) on 2026-06-28.
-- The anon role holds full SELECT/INSERT/UPDATE/DELETE grants on these tables,
-- and NEXT_PUBLIC_SUPABASE_ANON_KEY ships to the browser, so anyone could read
-- or mutate Book-of-Business contacts and campaign data with just the public URL.
--
-- The app never touches these tables with the anon key — every access goes
-- through server-side /api routes via getLeadsClient() (LRG_SUPABASE_SERVICE_KEY,
-- service-role), which bypasses RLS. So enabling RLS with NO policies yields
-- default-deny for anon/authenticated while leaving the app fully functional.
-- This matches the already-correct config on leads, dnc_list, drip_queue, etc.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op if already enabled.

alter table public.campaigns            enable row level security;
alter table public.relationships        enable row level security;
alter table public.relationship_touches enable row level security;
