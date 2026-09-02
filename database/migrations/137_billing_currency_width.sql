-- ---------------------------------------------------------------------------
-- 136. Give the currency columns room, and normalise what is already stored.
--
--      companies.currency is free text, so it can hold a display name such as
--      "Euro" or "Pakistani Rupee". Copying that into a VARCHAR(10) billing
--      column failed with "value too long for type character varying(10)" the
--      moment such a company tried to pay. The application now resolves the
--      name to an ISO code before writing, but the columns are widened so a
--      stray value can never take checkout down again.
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions          ALTER COLUMN currency TYPE VARCHAR(20);
ALTER TABLE billing_transactions   ALTER COLUMN currency TYPE VARCHAR(20);

-- Normalise the obvious display names already stored on companies, so the
-- billing settings show a code the payment providers accept.
UPDATE companies SET currency = 'EUR'
 WHERE lower(btrim(currency)) IN ('euro', 'euros', 'euro (eur)', '€');
UPDATE companies SET currency = 'GBP'
 WHERE lower(btrim(currency)) IN ('pound', 'pounds', 'sterling', 'pound sterling', 'british pound', '£');
UPDATE companies SET currency = 'USD'
 WHERE lower(btrim(currency)) IN ('dollar', 'dollars', 'us dollar', '$');
UPDATE companies SET currency = 'SAR'
 WHERE lower(btrim(currency)) IN ('riyal', 'riyals', 'saudi riyal');
UPDATE companies SET currency = 'CHF'
 WHERE lower(btrim(currency)) IN ('franc', 'francs', 'swiss franc');
UPDATE companies SET currency = 'PKR'
 WHERE lower(btrim(currency)) IN ('pakistani rupee', 'pakistan rupee');
UPDATE companies SET currency = 'INR'
 WHERE lower(btrim(currency)) IN ('indian rupee', 'rupee', 'rupees');
