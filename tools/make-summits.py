"""Builds extension/data/summits-benelux.json: named summits and passes in Belgium,
the Netherlands and Luxembourg from OpenStreetMap (via the Overpass API).

Bundled so climbs in this region get a summit name instantly, without any request.
Data © OpenStreetMap contributors, available under the ODbL 1.0 (see DATA-LICENSE.md).

Run from the repository root (needs internet, no extra packages):
    python tools/make-summits.py
"""
import json
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "data" / "summits-benelux.json"
COUNTRIES = ["BE", "NL", "LU"]
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
UA = "ClimbNamer-build (+https://github.com/bertpinoy/ClimbNamer)"

# Row kind codes, must match extension/summits.js
PEAK, PASS, HILL = 0, 1, 2


def query(cc: str) -> list:
    q = (
        f'[out:json][timeout:180];area["ISO3166-1"="{cc}"][admin_level=2]->.a;'
        '(node[name][natural~"^(peak|hill|saddle)$"](area.a);node[name][mountain_pass=yes](area.a););out;'
    )
    body = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for attempt in range(3):
        for url in ENDPOINTS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=200) as r:
                    return json.load(r)["elements"]
            except Exception as e:  # busy mirror: try the next one
                last = e
        time.sleep(20 * (attempt + 1))
    raise RuntimeError(f"Overpass failed for {cc}: {last}")


def kind(tags: dict) -> int:
    if tags.get("mountain_pass") == "yes" or tags.get("natural") == "saddle":
        return PASS
    return HILL if tags.get("natural") == "hill" else PEAK


def main() -> None:
    seen = {}
    for cc in COUNTRIES:
        els = query(cc)
        for e in els:
            seen[e["id"]] = [round(e["lat"], 5), round(e["lon"], 5), e["tags"]["name"], kind(e["tags"])]
        print(f"{cc}: {len(els)} summits/passes")
    rows = sorted(seen.values(), key=lambda r: (r[0], r[1]))
    data = {
        "source": "OpenStreetMap (natural=peak/hill/saddle, mountain_pass=yes; named nodes)",
        "license": "Data © OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright",
        "region": "Belgium, Netherlands, Luxembourg",
        "generated": date.today().isoformat(),
        "fields": ["lat", "lon", "name", "kind (0 peak, 1 pass/saddle, 2 hill)"],
        "rows": rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} rows, {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
