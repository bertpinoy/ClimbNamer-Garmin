# ClimbNamer for Garmin Connect and Strava — Privacy Policy

*Effective date: 12 November 2026*

ClimbNamer for Garmin Connect and Strava ("the extension") is a browser extension for
Google Chrome and Microsoft Edge that finds the climbs on courses in Garmin Connect
(connect.garmin.com) and on routes on Strava (www.strava.com) and gives them names. This policy explains what data the extension
uses, where it goes, and what is stored.

**In short:** the extension has no server of its own, no analytics and no tracking.
The only data that leaves your browser is the location of the climbs on the course or
route you are looking at, which is sent to public OpenStreetMap services to find their names.

## 1. Data the extension reads

While you view a course on connect.garmin.com, the extension reads, inside your browser,
the course data that the Garmin Connect page itself loads: the course's route points
(latitude, longitude, elevation and distance) and its name. It makes no requests to
Garmin itself.

While you view a route on www.strava.com, the extension reads, inside your browser, the
route data that the Strava page itself contains or loads: the route's line (latitude and
longitude), its elevation profile (distance and elevation) and its title. Only when a
route page's data didn't arrive the usual way, the extension reads that same route page
once more from Strava, with your existing session, as your browser would when reloading
it.

From these points the extension calculates where the climbs are. It does not read
activities, health data, your profile or your login details on either site, and does not
change anything in your Garmin or Strava account.

## 2. Data sent to third parties

To find a name for a climb, the extension sends **geographic coordinates of that
climb** (points along the climb and the position of its top, plus a small area around
it) to these public OpenStreetMap services. In addition, the first time you look at a
climb in a new area, the extension downloads the named summits and passes of that whole
area (a rectangle of about 55 × 50 km); that request contains only the rectangle's
coordinates. Climbs in Belgium, the Netherlands and Luxembourg can often be named from
summit data included in the extension itself, without any request.

| Service | Operated by | Used for |
|---|---|---|
| overpass-api.de | FOSSGIS e.V. (Germany) | Named summits, passes, roads and places near the climb |
| overpass.kumi.systems | Kumi Systems (Austria) | Same, as a mirror when the first one is busy |
| nominatim.openstreetmap.org | OpenStreetMap Foundation | Fallback when Overpass is busy |

No other information is added to these requests: no name, account, course or route name,
timestamps or other personal data. As with any web request, these services can see your
IP address and browser information. The requests identify the extension as
"ClimbNamer" with a link to this project. Their own privacy policies apply, for example
the [OpenStreetMap Foundation Privacy Policy](https://osmfoundation.org/wiki/Privacy_Policy).

Clicking ↗ in the climb panel opens openstreetmap.org in a new tab at the top of that
climb; this is a normal link you choose to follow.

The developer of ClimbNamer receives **no data at all**.

## 3. Data stored on your device

The extension stores, using your browser's extension storage:

- **Name cache** (local to this browser): the names found for climbs, keyed by rounded
  coordinates, and the named summits and passes of areas you looked at (at most 80
  areas). This avoids repeating lookups. You can clear it under
  *Settings → Clear name cache*, or by removing the extension.
- **Your settings and custom climb names** (browser *sync* storage): names you gave
  climbs with ✎ (with the coordinates of that climb) and whether the panel is collapsed.
  If you use browser sync, your browser provider (Google or Microsoft) syncs this
  between your devices, under their privacy policy.

## 4. What the extension does not do

- No analytics, telemetry, advertising or tracking.
- No selling, renting or sharing of data, and no use of data for any purpose other
  than finding and naming climbs on Garmin Connect courses and Strava routes.
- No use of data to determine creditworthiness or for lending purposes.
- No access to any website other than connect.garmin.com, www.strava.com and the OpenStreetMap
  services listed above.

## 5. Children

The extension is not directed at children and does not knowingly collect data from
anyone.

## 6. Changes

If this policy changes, the updated version will be published at
<https://github.com/bertpinoy/ClimbNamer-Garmin/blob/main/PRIVACY.md> with a new
effective date.

## 7. Contact

Questions or concerns: please open an issue at
<https://github.com/bertpinoy/ClimbNamer-Garmin/issues>.

---

ClimbNamer is an independent project and is not affiliated with, endorsed by or
sponsored by Garmin or Strava. Garmin and Garmin Connect are trademarks of Garmin Ltd. or its
subsidiaries; Strava is a trademark of Strava, Inc. Map data © OpenStreetMap contributors (ODbL).
