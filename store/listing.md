# Store listing — ClimbNamer for Garmin Connect

Texts to paste into the Chrome Web Store Developer Dashboard.

## Basics

| Field | Value |
|---|---|
| Chrome Web Store | Not submitted yet |
| Name | ClimbNamer - for Garmin Connect *(from the manifest)* |
| Category | *Productivity* (or *Tools*) |
| Language | English |
| Homepage / support URL | https://github.com/bertpinoy/ClimbNamer-Garmin |
| Support / contact | https://github.com/bertpinoy/ClimbNamer-Garmin/issues |
| Privacy policy URL | https://github.com/bertpinoy/ClimbNamer-Garmin/blob/main/PRIVACY.md |
| Icon | `extension/icons/icon-128.png` (from the zip) |
| Small promo tile (440×280) | `store/promo-tile-440x280.png` |
| Marquee promo tile (1400×560) | `store/marquee-1400x560.png` |
| Screenshots | 1280×800 PNG/JPEG, 1–5 pieces. **To do**: see below |

## Short description (manifest, max 132 characters)

> Finds and names the climbs on your Garmin Connect courses, using OpenStreetMap. Not affiliated with Garmin.

## Detailed description

```
Know which climbs are on your course.

Garmin Connect shows the elevation profile of your courses, but not where the climbs are or what they're called. ClimbNamer finds them and names them: Kemmelberg, Koppenberg, Mur de Huy, Col du Galibier.

WHAT IT DOES
When you open a course on connect.garmin.com, ClimbNamer detects its climbs from the elevation profile, with criteria similar to Garmin's ClimbPro, and shows a small panel with every climb:
• its name
• length, average gradient and elevation gain
• where on the course it starts

The climbs also appear on Garmin's own map and elevation chart: in orange on your route with numbered badges, and as orange numbered bands on the chart. Hover a climb in the panel to highlight it on the chart; click it and the map zooms to the climb.

WHY YOU'LL LIKE IT
• Plan better: see which climbs are on a course before you send it to your Edge or watch.
• Your own names: don't agree with a name, or want a local nickname? Rename the climb. Your name is used for that climb on all your courses.
• Fast: climbs named after a summit or pass appear instantly. Summits for Belgium, the Netherlands and Luxembourg are built in; elsewhere they are downloaded once per area. Every climb is looked up only once and remembered.
• Nothing to set up: install it, open a course in Garmin Connect, done.

WHERE THE NAMES COME FROM
ClimbNamer uses OpenStreetMap, the free world map made by volunteers:
1. If there is a named hill, summit or mountain pass at the top of the climb, that name is used.
2. Otherwise it uses the road the climb follows. In Flanders that is often the climb's name itself (Koppenberg, Paterberg, Oude Kwaremont).
3. Otherwise it says which village the climb is near.

Is a name wrong or missing? Rename the climb, or improve OpenStreetMap so every rider benefits.

PRIVACY
• No account and no sign-up.
• No tracking, no analytics, no advertising.
• No server of our own: nothing is sent to the developer.
• ClimbNamer only reads the course data that Garmin Connect already loads in your browser. Only the location of the climbs, and the outline of the area around them, is sent to public OpenStreetMap services to look up names.
• Your own climb names and settings are stored in your browser.
Full privacy policy: https://github.com/bertpinoy/ClimbNamer-Garmin/blob/main/PRIVACY.md

FAIR TO OPENSTREETMAP
The OpenStreetMap services are free and run by volunteers and non-profits. ClimbNamer is careful with them: each climb is looked up only once, summits are fetched once per area instead of per climb, requests go one at a time, and it pauses when the services are busy.

GOOD TO KNOW
• Works on connect.garmin.com (Courses) in Google Chrome and Microsoft Edge. You need your own Garmin Connect account.
• ClimbNamer never changes anything in your Garmin account.
• Open source: https://github.com/bertpinoy/ClimbNamer-Garmin. Questions, ideas or a climb with a wrong name? Open an issue there.
• Also available for the Hammerhead dashboard: ClimbNamer - for Hammerhead Dashboard.

ClimbNamer is an independent project and is not affiliated with, endorsed by or sponsored by Garmin. Garmin, Garmin Connect and ClimbPro are trademarks of Garmin Ltd. or its subsidiaries.
Map data © OpenStreetMap contributors, ODbL.
```

## Chrome: Privacy practices tab

**Single purpose description**

```
ClimbNamer finds the climbs on the user's courses in Garmin Connect (connect.garmin.com) and shows their names, looked up in OpenStreetMap, in a panel and on the course's elevation chart.
```

**Permission justifications**

*storage*
```
Stores a cache of climb names so each climb is looked up only once, the named summits of areas the user looked at, the user's own names for climbs, and the extension's settings. Nothing is sent to the developer.
```

*declarativeNetRequestWithHostAccess*
```
Used only to set an identifying User-Agent header ("ClimbNamer/<version> (+https://github.com/bertpinoy/ClimbNamer-Garmin)") on the extension's own requests to the OpenStreetMap services (overpass-api.de, overpass.kumi.systems, nominatim.openstreetmap.org), as their usage policies require apps to identify themselves. The rule is limited to requests initiated by this extension; it does not block, redirect or modify any other requests.
```

*Host permission use*
```
https://connect.garmin.com/*: the extension runs only on Garmin Connect, where it reads the course data the page already loads to detect the climbs, and shows their names in the page. It never changes anything in the user's account and makes no requests to Garmin itself.
https://overpass-api.de/*, https://overpass.kumi.systems/* and https://nominatim.openstreetmap.org/*: public OpenStreetMap services used to look up the names of summits, passes, roads and villages at the coordinates of each climb. Only climb coordinates are sent.
```

**Remote code:** No, I am not using remote code.

**Data usage:** tick **Location** (climb coordinates are sent to OpenStreetMap services
to look up names); leave the other categories unticked. Tick all three certifications.

## Screenshots (to do)

Make 1280×800 screenshots in a desktop browser window, for example:

1. A course with the ClimbNamer panel, the climbs in orange on the map and the bands on the elevation chart.
2. A climb clicked in the panel: map zoomed to the climb (orange on the route) and picked out on the chart.
3. A long or hilly course with many climbs.

Tip: pick courses that don't start at your home address.
