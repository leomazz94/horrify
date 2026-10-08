#!/usr/bin/env python3
"""Import OSM cinema features from Geofabrik into HORRIFY Supabase."""
import json, os, sys, urllib.request
from shapely.geometry import shape
URL=os.environ["SUPABASE_URL"].rstrip("/")+"/rest/v1/radar_cinemas?on_conflict=osm_type,osm_id"
KEY=os.environ["SUPABASE_SERVICE_ROLE_KEY"]
batch=[];count=0
def upload(rows):
    body=json.dumps(rows,ensure_ascii=False).encode()
    req=urllib.request.Request(URL,data=body,method="POST",headers={"apikey":KEY,"Authorization":"Bearer "+KEY,"Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=minimal"})
    with urllib.request.urlopen(req,timeout=90) as resp:
        if resp.status not in (200,201,204):raise RuntimeError("Supabase import failed")
with open(sys.argv[1],encoding="utf-8") as f:
 for line in f:
    line=line.lstrip(chr(30)).strip()
    if not line:continue
    obj=json.loads(line); props=obj.get("properties") or {}
    if not props.get("name"):continue
    osm_id=str(obj.get("id") or "")
    if "/" in osm_id:
        osm_type,number=osm_id.split("/",1)
    elif len(osm_id)>1 and osm_id[0] in "nwr" and osm_id[1:].isdigit():
        osm_type={"n":"node","w":"way","r":"relation"}[osm_id[0]]
        number=osm_id[1:]
    elif osm_id.isdigit() and obj.get("type") in ("node","way","relation"):
        osm_type,number=obj["type"],osm_id
    else:
        continue
    if osm_type not in ("node","way","relation") or not number.isdigit():continue
    geom=obj.get("geometry")
    if not geom:continue
    point=shape(geom).representative_point()
    if not (-90<=point.y<=90 and -180<=point.x<=180):continue
    website=props.get("website") or props.get("contact:website")
    if website and not str(website).startswith(("http://","https://")):website=None
    row={"osm_type":osm_type,"osm_id":int(number),"name":str(props["name"])[:300],"latitude":point.y,"longitude":point.x,"city":props.get("addr:city"),"address":" ".join(str(props.get(k,"")) for k in ("addr:street","addr:housenumber")).strip() or None,"website":website,"source":"openstreetmap","active":True}
    batch.append(row)
    if len(batch)>=200:upload(batch);count+=len(batch);batch=[]
if batch:upload(batch);count+=len(batch)
if count==0:raise RuntimeError("No cinemas parsed from GeoJSON export; refusing silent success")
print(f"Imported or updated {count} OSM cinemas")
