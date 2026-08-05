-- Store travel range in miles.
--
-- The product is Milwaukee-first and nobody in the scene says "I'll drive 80
-- km." The form asked in km, the profile printed km, and the only honest options
-- were to keep an alien unit everywhere or convert at the display boundary —
-- which would have shown a tech who typed 50 a profile reading 31. So the unit
-- changes end to end, values and all.
alter table performers rename column travel_radius_km to travel_radius_miles;
alter table techs      rename column travel_radius_km to travel_radius_miles;

-- Convert what's already stored. greatest(...,1) so a small non-zero radius
-- can't round down to "travels nowhere"; 0 stays 0 (it means "local only").
update performers set travel_radius_miles =
  case when travel_radius_miles = 0 then 0
       -- The old form allowed 500 km, which rounds to 311 miles, while the new
       -- miles form intentionally caps entries at 300. Clamp converted legacy
       -- values so every migrated profile remains valid on its next edit.
       else least(300, greatest(1, round(travel_radius_miles * 0.621371))) end;
update techs set travel_radius_miles =
  case when travel_radius_miles = 0 then 0
       else least(300, greatest(1, round(travel_radius_miles * 0.621371))) end;

-- 30 miles ≈ the old 50 km default, kept close so behavior doesn't jump.
alter table performers alter column travel_radius_miles set default 30;
alter table techs      alter column travel_radius_miles set default 30;
