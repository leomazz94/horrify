#!/usr/bin/env python3
"""Import OSM cinema features from Geofabrik into HORRIFY Supabase (table radar_cinemas).

Input: the GeoJSON text sequence written by
  osmium export cinemas.osm.pbf -f geojsonseq --add-unique-id=type_id

Row conversion is unchanged from test/horror-radar-v14 (88f3773). Unlike that version, the whole
file is parsed and validated before the first write, and --dry-run never touches the network.

Checks (any failure aborts before writing):
  - at least one feature and one importable cinema;
  - named features with an unparsable OSM id: at most --max-invalid-ids (default 0, because
    --add-unique-id=type_id always emits n/w/r ids; a different format silently produced
    zero-row imports in the past);
  - no duplicate (osm_type, osm_id), which would make the upsert fail halfway;
  - optional --min-count;
  - import only: if radar_cinemas already holds OpenStreetMap rows, --max-drop-percent is required
    and the new count may not fall below that percentage of the existing one.
"""
import argparse
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from collections import Counter

BATCH_SIZE = 200
OSM_TYPES = {"n": "node", "w": "way", "r": "relation"}
SOURCE = "openstreetmap"


class ImportAborted(Exception):
    pass


def parse_osm_id(obj):
    """Return (osm_type, number) from an osmium feature, or None."""
    osm_id = str(obj.get("id") or "")
    if "/" in osm_id:
        osm_type, number = osm_id.split("/", 1)
    elif len(osm_id) > 1 and osm_id[0] in "nwr" and osm_id[1:].isdigit():
        osm_type, number = OSM_TYPES[osm_id[0]], osm_id[1:]
    elif osm_id.isdigit() and obj.get("type") in ("node", "way", "relation"):
        osm_type, number = obj["type"], osm_id
    else:
        return None
    if osm_type not in ("node", "way", "relation") or not number.isdigit():
        return None
    return osm_type, number


def representative_point(geom):
    """(lon, lat) of a representative point. Points need no geometry library."""
    if geom.get("type") == "Point":
        coords = geom.get("coordinates") or []
        return float(coords[0]), float(coords[1])
    from shapely.geometry import shape  # only polygons/lines need shapely
    point = shape(geom).representative_point()
    return point.x, point.y


def feature_to_row(obj):
    """Return (row, None) or (None, skip_reason)."""
    props = obj.get("properties") or {}
    if not props.get("name"):
        return None, "no_name"
    parsed = parse_osm_id(obj)
    if parsed is None:
        return None, "invalid_id"
    osm_type, number = parsed
    geom = obj.get("geometry")
    if not geom:
        return None, "no_geometry"
    lon, lat = representative_point(geom)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None, "out_of_range"
    website = props.get("website") or props.get("contact:website")
    if website and not str(website).startswith(("http://", "https://")):
        website = None
    return {
        "osm_type": osm_type,
        "osm_id": int(number),
        "name": str(props["name"])[:300],
        "latitude": lat,
        "longitude": lon,
        "city": props.get("addr:city"),
        "address": " ".join(str(props.get(k, "")) for k in ("addr:street", "addr:housenumber")).strip() or None,
        "website": website,
        "source": SOURCE,
        "active": True,
    }, None


def collect_rows(lines):
    """Parse a GeoJSON text sequence (RFC 8142 record separators allowed)."""
    rows, stats, seen = [], Counter(), Counter()
    for line in lines:
        line = line.lstrip(chr(30)).strip()
        if not line:
            continue
        stats["features"] += 1
        row, reason = feature_to_row(json.loads(line))
        if reason:
            stats["skipped_" + reason] += 1
            continue
        rows.append(row)
        seen[(row["osm_type"], row["osm_id"])] += 1
    stats["rows"] = len(rows)
    stats["duplicate_ids"] = sum(n - 1 for n in seen.values() if n > 1)
    for row in rows:
        stats["rows_" + row["osm_type"]] += 1
        stats["rows_with_website"] += bool(row["website"])
        stats["rows_with_city"] += bool(row["city"])
    return rows, stats


def validate(stats, *, max_invalid_ids=0, min_count=None, baseline=None, max_drop_percent=None):
    """Return a list of problems; empty means the import may proceed."""
    problems = []
    if stats["features"] == 0:
        problems.append("the export contains no features")
    if stats["rows"] == 0:
        problems.append("no importable cinemas were parsed")
    if stats["skipped_invalid_id"] > max_invalid_ids:
        problems.append(f"{stats['skipped_invalid_id']} named features have an unparsable OSM id (allowed: {max_invalid_ids}); the export format may have changed")
    if stats["duplicate_ids"]:
        problems.append(f"{stats['duplicate_ids']} duplicate OSM ids in the export")
    if min_count is not None and stats["rows"] < min_count:
        problems.append(f"{stats['rows']} cinemas parsed, below --min-count {min_count}")
    if baseline:
        if max_drop_percent is None:
            problems.append(f"radar_cinemas already holds {baseline} OpenStreetMap rows: set --max-drop-percent (see the dry-run report)")
        else:
            floor = math.ceil(baseline * (100 - max_drop_percent) / 100)
            if stats["rows"] < floor:
                problems.append(f"{stats['rows']} cinemas parsed vs {baseline} already imported: a drop larger than {max_drop_percent}% (minimum {floor})")
    return problems


class SupabaseRest:
    """Minimal PostgREST client for radar_cinemas (service role, server-side only)."""

    def __init__(self, url, key, opener=urllib.request.urlopen):
        if not url or not key:
            raise ImportAborted("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for an import")
        if not url.startswith("https://"):
            raise ImportAborted("SUPABASE_URL must use https")
        self.base = url.rstrip("/") + "/rest/v1/radar_cinemas"
        self.key = key
        self.open = opener

    def _headers(self, extra):
        return {"apikey": self.key, "Authorization": "Bearer " + self.key, **extra}

    def count_existing(self):
        query = urllib.parse.urlencode({"select": "osm_id", "source": "eq." + SOURCE})
        req = urllib.request.Request(self.base + "?" + query, method="GET", headers=self._headers({"Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"}))
        with self.open(req, timeout=90) as resp:
            if resp.status not in (200, 206):
                raise ImportAborted("could not read the current cinema count")
            total = (resp.headers.get("Content-Range") or "").rsplit("/", 1)[-1]
        if not total.isdigit():
            raise ImportAborted("could not read the current cinema count")
        return int(total)

    def upsert(self, rows):
        body = json.dumps(rows, ensure_ascii=False).encode()
        req = urllib.request.Request(self.base + "?on_conflict=osm_type,osm_id", data=body, method="POST", headers=self._headers({"Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"}))
        with self.open(req, timeout=90) as resp:
            if resp.status not in (200, 201, 204):
                raise RuntimeError("Supabase import failed")


def non_negative_int(value):
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must be >= 0")
    return number


def percent(value):
    number = float(value)
    if not 0 <= number <= 100:
        raise argparse.ArgumentTypeError("must be between 0 and 100")
    return number


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("geojsonseq")
    parser.add_argument("--dry-run", action="store_true", help="parse and validate only; no network, no credentials")
    parser.add_argument("--min-count", type=non_negative_int)
    parser.add_argument("--max-drop-percent", type=percent)
    parser.add_argument("--max-invalid-ids", type=non_negative_int, default=0)
    parser.add_argument("--summary-out", help="write the summary as JSON to this file")
    return parser.parse_args(argv)


def run(argv, environ=os.environ, opener=urllib.request.urlopen, out=sys.stdout):
    args = parse_args(argv)
    with open(args.geojsonseq, encoding="utf-8") as f:
        rows, stats = collect_rows(f)
    client = None if args.dry_run else SupabaseRest(environ.get("SUPABASE_URL"), environ.get("SUPABASE_SERVICE_ROLE_KEY"), opener)
    baseline = client.count_existing() if client else None
    problems = validate(stats, max_invalid_ids=args.max_invalid_ids, min_count=args.min_count, baseline=baseline, max_drop_percent=args.max_drop_percent)
    summary = {"mode": "dry-run" if args.dry_run else "import", "existing_openstreetmap_rows": baseline, **dict(sorted(stats.items())), "problems": problems}
    if args.summary_out:
        with open(args.summary_out, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2), file=out)
    if problems:
        raise ImportAborted("; ".join(problems))
    if client:
        for start in range(0, len(rows), BATCH_SIZE):
            client.upsert(rows[start:start + BATCH_SIZE])
        print(f"Imported or updated {len(rows)} OSM cinemas", file=out)
    else:
        print(f"Dry run: {len(rows)} OSM cinemas would be imported; nothing was written", file=out)
    return summary


def main():
    try:
        run(sys.argv[1:])
    except ImportAborted as error:
        print("Import aborted: " + str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
