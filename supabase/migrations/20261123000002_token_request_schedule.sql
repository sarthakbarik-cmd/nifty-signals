-- Upstox one-tap approval: at 08:45 IST on weekdays ask Upstox to send an approval request
-- to the owner's phone (Upstox app + WhatsApp). Holidays and "already logged in" are skipped
-- inside the function. 08:45 IST = 03:15 UTC.
select cron.schedule('request_token', '15 3 * * 1-5', $$ select private.call_api('request_token') $$);
