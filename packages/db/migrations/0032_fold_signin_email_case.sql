-- Fold stored sign-in emails to lowercase, matching the schema that now folds
-- them on the way in.
--
-- Before this, auth/request stored the OTP under the address as typed and
-- auth/verify looked the user up with an exact match, so Foo@x.com and
-- foo@x.com were two different accounts and signing in with the "wrong"
-- capitalisation silently minted a second one.
--
-- Refuse rather than guess if two accounts differ only by case: merging them
-- means deciding which profiles, bookings, reviews and ledger history survive,
-- and that is not a decision a migration can make. Same posture as 0030.
DO $migration$
DECLARE
  colliding text;
BEGIN
  SELECT string_agg(lower_email, ', ' ORDER BY lower_email)
  INTO colliding
  FROM (
    SELECT lower(email) AS lower_email
    FROM users
    WHERE email IS NOT NULL
    GROUP BY lower(email)
    HAVING count(*) > 1
    LIMIT 20
  ) AS dupes;

  IF colliding IS NOT NULL THEN
    RAISE EXCEPTION
      '0032_fold_signin_email_case: accounts differ only by capitalisation: %',
      colliding
      USING
        ERRCODE = '23505',
        HINT = 'Merge or deactivate the duplicate accounts, then rerun.';
  END IF;
END
$migration$;

update users
   set email = lower(email)
 where email is not null and email <> lower(email);

-- Outstanding codes keep working instead of silently failing to match.
update auth_otps
   set destination = lower(destination)
 where destination like '%@%' and destination <> lower(destination);

-- New rows are folded by the app; this keeps a stray direct insert honest.
create unique index if not exists users_email_lower_uq
  on users (lower(email)) where email is not null;
