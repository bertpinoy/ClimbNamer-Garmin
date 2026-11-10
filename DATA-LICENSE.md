# Data licence

ClimbNamer includes and downloads map data from **OpenStreetMap**.

- `extension/data/summits-benelux.json`: named summits and passes in Belgium, the
  Netherlands and Luxembourg, extracted from OpenStreetMap with
  [`tools/make-summits.py`](tools/make-summits.py).
- Summit areas downloaded by the extension at runtime and stored in the browser.
- Climb names looked up at runtime.

This data is © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) and
is made available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
The extracted file above is a derivative database and is likewise made available under
the ODbL 1.0. You may copy, distribute and adapt it, as long as you attribute
OpenStreetMap and its contributors and share any adapted database under the same licence.

To rebuild the file from current OpenStreetMap data, run `python tools/make-summits.py`.

Corrections belong in OpenStreetMap itself: <https://www.openstreetmap.org/fixthemap>.
