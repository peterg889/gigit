-- Forward repair for databases that already recorded 0026 before its legacy
-- conversion was clamped. The old 500 km maximum became 311 miles, but current
-- performer/tech schemas accept at most 300, so an unchanged profile edit could
-- fail validation until these stored values are brought into range.
update performers
   set travel_radius_miles = 300
 where travel_radius_miles > 300;

update techs
   set travel_radius_miles = 300
 where travel_radius_miles > 300;
