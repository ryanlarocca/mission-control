-- Appointment details (2026-11-05). appointment_at stays the funnel
-- milestone (a date at noon UTC); this carries the time, the place, the
-- Google Calendar event it was booked as and where the booking came from
-- (a call transcript, a Telegram message), so the card can show
-- "Fri 5:00 PM · 265 Main St" and Undo can remove the calendar event.
alter table public.leads add column if not exists appointment_details jsonb;
