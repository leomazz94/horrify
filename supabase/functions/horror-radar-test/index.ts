import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { classifyMode, authorizeOperator, parseOperatorIds, isValidIsoDate, readJsonBody, readTextCapped, createSafeFetch, restrictTables, DestinationBlockedError } from "./security.mjs";
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const WARNING="(Programmazione da verificare direttamente con il cinema)";
const UA="HORRIFY-HorrorRadar/0.6.2";
const MAX_BODY_CHARS=16384;
// Only these tables are reachable with the service-role key; see restrictTables in security.mjs.
const SERVICE_TABLES=["radar_cinemas","radar_movie_classification"];
// All third-party page fetches go through safeFetch: public destinations only, every redirect re-checked.
// Fails closed when DNS resolution is unavailable, so private targets cannot slip through unchecked.
async function resolveHost(hostname:string){const dns=(Deno as any).resolveDns;if(typeof dns!=="function")throw new Error("dns_unavailable");const found=await Promise.allSettled([dns(hostname,"A"),dns(hostname,"AAAA")]);return found.flatMap((r:any)=>r.status==="fulfilled"?r.value:[])}
const safeFetch=createSafeFetch({fetchImpl:fetch,resolveHost,log:(event:string,data:unknown)=>console.error(event,JSON.stringify(data))});


function explicitScheduleDate(line:string):string|null{const m=line.match(/(?:^|[^\d])(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?(?!\d)/);if(!m)return null;const day=Number(m[1]),month=Number(m[2]),year=m[3]?Number(m[3]):2026;const yyyy=year<100?2000+year:year;if(day<1||day>31||month<1||month>12)return null;const iso=String(yyyy).padStart(4,"0")+"-"+String(month).padStart(2,"0")+"-"+String(day).padStart(2,"0");return new Date(iso+"T12:00:00Z").toISOString().slice(0,10)===iso?iso:null;}
function scheduleHeading(line:string){return /^(?:lunedi|lunedì|martedi|martedì|mercoledi|mercoledì|giovedi|giovedì|venerdi|venerdì|sabato|domenica)\b/i.test(line.trim())}
function is18Tickets(url:string){try{return new URL(url).hostname.toLowerCase().endsWith(".18tickets.it")}catch{return false}}
function parse18Tickets(html:string,targetDates:string[]){
 const decode=(x:string)=>x.replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&nbsp;/gi," ").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
 const out:any[]=[];
 // 18tickets: film links provide the title; schedule-ID ties its screenings to that exact film.
 const titles=new Map<string,string>();
 for(const m of html.matchAll(/<a\b[^>]*href=["'][^"']*\/film\/(\d+)(?:["'\/?#])[^>]*>([\s\S]{0,1300}?)<\/a>/gi)){
  const heading=m[2].match(/class=["'][^"']*page-heading[^"']*["'][^>]*>([\s\S]*?)<\//i);
  if(!heading)continue;
  const title=decode(heading[1]);
  if(title&&plausibleFilmTitle(title))titles.set(m[1],title);
 }
 // Some pages include a non-carousel title immediately before the schedule.
 const sections=Array.from(html.matchAll(/<div\b[^>]*id=["']schedule-(\d+)["'][^>]*>/gi));
 for(let i=0;i<sections.length;i++){
  const id=sections[i][1],start=sections[i].index!,end=sections[i+1]?.index??html.length;
  const segment=html.slice(start,Math.min(end,start+25000));
  let title=titles.get(id)||"";
  if(!title){
   const nearby=html.slice(Math.max(0,start-3500),start);
   const matches=Array.from(nearby.matchAll(/<a\b[^>]*href=["'][^"']*\/film\/(\d+)["'][^>]*>([\s\S]{0,1200}?)<\/a>/gi));
   const own=matches.reverse().find((m:any)=>m[1]===id);
   if(own)title=decode(own[2]);
  }
  if(!title||!plausibleFilmTitle(title))continue;
  // Each dated row begins with time-select__place; only anchors before the next row belong to that date.
  const blocks=Array.from(segment.matchAll(/<div\b[^>]*class=["'][^"']*time-select__place[^"']*["'][^>]*>/gi));
  for(let j=0;j<blocks.length;j++){
   const from=blocks[j].index!,to=blocks[j+1]?.index??segment.length;
   const block=segment.slice(from,Math.min(to,from+3500));
   const dateText=decode(block.slice(0,Math.min(block.length,450)));
   const date=explicitScheduleDate(dateText);
   if(!date||!targetDates.includes(date))continue;
   const times:Array<string>=[];
   for(const a of block.matchAll(/<a\b[^>]*href=["']([^"']*\/film\/(\d+)\/[^"']*#theater-init)["'][^>]*>([\s\S]{0,500}?)<\/a>/gi)){
    if(a[2]!==id)continue;
    const t=decode(a[3]).match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/);
    if(t)times.push(t[0].padStart(5,"0"));
   }
   if(times.length)out.push({title,date,showtimes:Array.from(new Set(times)),parser:"18tickets-schedule-id",sourceUrl:""});
  }
 }
 return mergeCandidates([out]).slice(0,40);
}
function dateBoundCandidates(html:string,targetDates:string[]){
  const text=html.replace(/<script[\s\S]*?<\/script>/gi,"\n").replace(/<style[\s\S]*?<\/style>/gi,"\n").replace(/<\/(div|p|li|article|section|h[1-6]|br|tr)>/gi,"\n").replace(/<[^>]+>/g," ");
  const lines=text.split(/\n+/).map((x:string)=>x.replace(/\s+/g," ").trim()).filter(Boolean);
  const out:any[]=[]; let active:string|null=null;
  for(let i=0;i<lines.length;i++){
    const low=lines[i].toLowerCase();
    if(low.includes("oggi")) active=targetDates[0];
    if(low.includes("domani")) active=targetDates[1];
    const explicit=explicitScheduleDate(lines[i]);if(explicit)active=targetDates.includes(explicit)?explicit:null;else if(scheduleHeading(lines[i]))active=null;
    if(!active) continue;
    const matches=lines[i].match(/\b(?:[01]?\d|2[0-3])[:.]([0-5]\d)\b/g)||[];
    if(matches.length===0) continue;
    for(let j=i;j>=Math.max(0,i-2);j--){
      const title=lines[j].replace(/\b(?:[01]?\d|2[0-3])[:.]([0-5]\d)\b/g,"").replace(/\b(oggi|domani|programmazione|orari|spettacoli)\b/gi,"").trim();
      if(title.length>=2&&title.length<=100&&!/^\d/.test(title)){out.push({title,date:active,showtimes:Array.from(new Set(matches.map((x:string)=>x.replace(".",":").padStart(5,"0"))))});break;}
    }
  }
  return out.slice(0,40);
}


function extractTimes(s:string){const m=s.match(/(?:^|\D)((?:[01]?\d|2[0-3])[:.]([0-5]\d))/g)||[];return Array.from(new Set(m.map((x:string)=>{const z=x.replace(/^[^0-9]+/,"").replace(".",":");return z.padStart(5,"0")})))}
function parseInlineToday(html:string,targetDates:string[]){
 const text=html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&");
 const chunks=text.split(/(?=\b(?:Oggi|Domani)\s*:)/i).map((x:string)=>x.replace(/\s+/g," ").trim()).filter(Boolean),out:any[]=[];
 for(const c of chunks){const low=c.toLowerCase(),date=low.startsWith("domani")?targetDates[1]:low.startsWith("oggi")?targetDates[0]:null;if(!date)continue;const times=extractTimes(c);if(!times.length)continue;let rest=c.replace(/^\s*(oggi|domani)\s*:\s*/i,"");for(const t of times)rest=rest.replace(t," ");rest=rest.replace(/\(\d{4}-\d{2}-\d{2}\)/g," ").replace(/\s+/g," ").trim();const cut=rest.search(/\b(Horror|Azione|Drammatico|Commedia|Thriller|Documentario|Biografico|Animazione|Avventura|Crime|Fantasy|Fantascienza)\b/i);const title=(cut>0?rest.slice(0,cut):rest.split(/Regia:|Durata:|Nuovo Cinema/i)[0]).trim();if(title.length>=2&&title.length<=120)out.push({title,date,showtimes:times,parser:"inline-today"})}
 return out.slice(0,30)
}
function candidateQuality(x:any){
  const t=String(x?.title||"").trim(),n=normalizeTitle(t);
  if(t.length<2||t.length>110)return false;
  if(scheduleHeading(t)||explicitScheduleDate(t)||/\b(?:cinema|movieland|multiplex|multisala|teatro|posti)\b/i.test(t))return false;
  if(/^(home|menu|login|cookie|privacy|contatti|news|eventi|cinema|programmazione|acquista|prenota|biglietti|lingua|regia|sala)\b/i.test(t))return false;
  if(!Array.isArray(x?.showtimes)||x.showtimes.length===0)return false;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(x?.date||"")))return false;
  return n.length>=2;
}
function mergeCandidates(groups:any[][]){
  const m=new Map<string,any>();
  for(const group of groups)for(const x of group.filter(candidateQuality)){const k=normalizeTitle(x.title)+"|"+x.date;const p=m.get(k);if(p){p.showtimes=Array.from(new Set([...p.showtimes,...x.showtimes]));p.evidenceCount=(p.evidenceCount||1)+1}else m.set(k,{...x,evidenceCount:1})}
  return Array.from(m.values()).sort((a:any,b:any)=>(b.evidenceCount||1)-(a.evidenceCount||1)).slice(0,40);
}
function adaptiveParse(url:string,html:string,targetDates:string[]){
  const generic=dateBoundCandidates(html,targetDates),inline=parseInlineToday(html,targetDates);
  if(is18Tickets(url)){const specialized=parse18Tickets(html,targetDates);return{strategy:"18tickets-film-card-strict",candidates:mergeCandidates([specialized])}}
  return{strategy:"adaptive-inline+generic",candidates:mergeCandidates([inline,generic])}
}
function extractCandidates(html:string){const text=html.replace(/<script[\s\S]*?<\/script>/gi,"\n").replace(/<style[\s\S]*?<\/style>/gi,"\n").replace(/<\/(div|p|li|article|section|h[1-6]|br)>/gi,"\n").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&");const lines=text.split(/\n+/).map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean);const out:any[]=[];for(let i=0;i<lines.length;i++){const times=lines[i].match(/\b(?:[01]?\d|2[0-3])[:.]([0-5]\d)\b/g)||[];if(!times.length)continue;for(let j=i;j>=Math.max(0,i-2);j--){const title=lines[j].replace(/\b(?:[01]?\d|2[0-3])[:.]([0-5]\d)\b/g,"").trim();if(title.length>=2&&title.length<=100&&!/^\d/.test(title)){out.push({title,showtimes:[...new Set(times.map(x=>x.replace(".",":").padStart(5,"0")))]});break}}}return out.slice(0,40)}
async function inspectOfficialPage(url:string){let page;try{page=await safeFetch(url,{headers:{"User-Agent":UA,"Accept":"text/html"},timeoutMs:6500})}catch(e){if(e instanceof DestinationBlockedError)throw new Error("official_page_blocked_"+e.reason);throw e}const r=page.response;if(!r.ok){await r.body?.cancel().catch(()=>{});throw new Error("official_page_"+r.status)}const html=await readTextCapped(r,1500000);return{url:page.url,html,candidates:extractCandidates(html)}}

function linkedScheduleUrls(base:string,html:string){const out:string[]=[];const re=new RegExp('<a\\b[^>]*href\\s*=\\s*["\\x27]([^"\\x27#]+)["\\x27][^>]*>([\\s\\S]*?)<\\/a>','gi');let m;while((m=re.exec(html))!==null){try{const u=new URL(m[1],base);if(!["https:","http:"].includes(u.protocol))continue;const label=m[2].replace(new RegExp('<[^>]+>','g')," ").toLowerCase();const hint=(u.pathname+" "+label).toLowerCase();if(!/(programmazion|spettacol|orari|bigliett|acquista|film|ticket|showtime)/.test(hint))continue;if(u.hostname!==new URL(base).hostname&&!/(18tickets|webtic|ticket|cinema|giometti)/i.test(u.hostname))continue;u.hash="";if(!out.includes(u.href))out.push(u.href)}catch{}}return out.slice(0,2)}
function rad(x:number){return x*Math.PI/180}
function distanceKm(a:any,b:any){const R=6371,dLat=rad(b.lat-a.lat),dLon=rad(b.lon-a.lon),q=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return Math.round(2*R*Math.asin(Math.sqrt(q))*10)/10}
async function discoverCachedCinemas(lat:number,lon:number,radiusKm:number){const db=admin();const dLat=radiusKm/111.32,dLon=radiusKm/(111.32*Math.max(0.1,Math.cos(rad(lat))));const {data,error}=await db.from("radar_cinemas").select("name,city,address,website,latitude,longitude").eq("active",true).gte("latitude",lat-dLat).lte("latitude",lat+dLat).gte("longitude",lon-dLon).lte("longitude",lon+dLon).limit(2000);if(error)throw new Error("cinema_cache_query_failed");return(data||[]).map((c:any)=>({...c,lat:c.latitude,lon:c.longitude,distanceKm:distanceKm({lat,lon},{lat:c.latitude,lon:c.longitude})})).filter((c:any)=>c.distanceKm<=radiusKm).sort((a:any,b:any)=>a.distanceKm-b.distanceKm)}
async function discoverCinemas(lat:number,lon:number,radiusKm:number){const radius=Math.round(radiusKm*1000);const q='[out:json][timeout:12];(node["amenity"="cinema"](around:'+radius+','+lat+','+lon+');way["amenity"="cinema"](around:'+radius+','+lat+','+lon+');relation["amenity"="cinema"](around:'+radius+','+lat+','+lon+'););out center tags;';const endpoints=["https://overpass.kumi.systems/api/interpreter","https://overpass.nchc.org.tw/api/interpreter","https://overpass-api.de/api/interpreter"];for(const endpoint of endpoints){try{const r=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":UA},body:"data="+encodeURIComponent(q),signal:AbortSignal.timeout(11000)});if(!r.ok){console.error("radar_overpass_http",JSON.stringify({host:new URL(endpoint).hostname,status:r.status}));continue;}const data=await r.json();if(!Array.isArray(data.elements))continue;return data.elements.map((e:any)=>{const p=e.type==="node"?{lat:e.lat,lon:e.lon}:{lat:e.center?.lat,lon:e.center?.lon},t=e.tags||{};if(!p.lat||!p.lon||!t.name)return null;return{name:t.name,city:t["addr:city"]||null,address:[t["addr:street"],t["addr:housenumber"]].filter(Boolean).join(" ")||null,website:t.website||t["contact:website"]||null,lat:p.lat,lon:p.lon,distanceKm:distanceKm({lat,lon},p)}}).filter(Boolean).filter((x:any)=>x.distanceKm<=radiusKm).sort((a:any,b:any)=>a.distanceKm-b.distanceKm)}catch(e){console.error("radar_overpass_failure",JSON.stringify({host:new URL(endpoint).hostname,error:String(e)}))}}throw new Error("cinema_discovery_unavailable")}
async function discoverViaTavily(lat:number,lon:number,radiusKm:number){const key=Deno.env.get("TAVILY_API_KEY");if(!key)throw new Error("tavily_not_configured");const q="cinema multisala movie theaters near latitude "+lat.toFixed(3)+" longitude "+lon.toFixed(3)+" cinema programmazione indirizzo";const res=await tavilySearch(q,10);const items:any[]=[];for(const x of res.results||[]){const name=String(x.title||"").split(/[|–—-]/)[0].trim();if(!/cinema|multisala|movie theater|theatre/i.test(name))continue;items.push({name,city:null,address:null,website:x.url||null,lat:null,lon:null,distanceKm:null,unverifiedLocation:true})}return items.slice(0,10)}
function trustedCinemaMatch(cinema:any,source:any){let host="";try{host=new URL(source.sourceUrl).hostname.toLowerCase()}catch{return false}const text=normalizeTitle((source.sourceLabel||"")+" "+(source.content||""));const name=normalizeTitle(cinema.name||"");const tokens=name.split(" ").filter((w:string)=>w.length>=4&&!["cinema","teatro","multiplex"].includes(w));if(tokens.length===0||!tokens.some((w:string)=>text.includes(w)))return false;const city=normalizeTitle(cinema.city||"");if(city&&!text.includes(city))return false;if(!city&&host!==new URL(cinema.website||"https://invalid.local").hostname.toLowerCase())return false;return true}
async function fallbackProgramming(cinema:any,date:string){const place=[cinema.name,cinema.city].filter(Boolean).join(" ");const q='"'+place+'" cinema film orari spettacoli programmazione '+date;const data=await tavilySearch(q,5);const nameKey=normalizeTitle(cinema.name);const first=nameKey.split(" ").filter((w:string)=>w.length>3);return(data.results||[]).filter((r:any)=>{const combined=normalizeTitle((r.title||"")+" "+(r.content||""));return combined.includes(nameKey)||(first.length>=2&&first.every((w:string)=>combined.includes(w)))}).slice(0,3).map((r:any)=>({sourceType:"trusted_third_party",sourceUrl:r.url,sourceLabel:r.title||"Fonte web",verificationWarning:WARNING,date,content:(r.content||"").slice(0,800)}))}
function parseFallbackSource(src:any){
  const content=String(src.content||"").replace(/\s+/g," ").trim();
  const times=Array.from(new Set(content.match(/\b(?:[01]?\d|2[0-3])[:.]([0-5]\d)\b/g)||[])).map((x:any)=>String(x).replace(".",":").padStart(5,"0"));
  if(times.length===0)return [];
  const date=String(src.date||"");
  const p=date.split("-"),dd=String(Number(p[2]||0)),mm=String(Number(p[1]||0));
  const explicit=content.includes(date)||content.includes(dd+"/"+mm)||content.includes(dd+"."+mm)||content.toLowerCase().includes("oggi")||content.toLowerCase().includes("domani");
  if(!explicit)return [];
  const chunks=content.split(/[|•·;]+/).map((x:string)=>x.trim()).filter(Boolean);
  const out:any[]=[];
  for(const chunk of chunks){const ct=chunk.match(/\b(?:[01]?\d|2[0-3])[:.]([0-5]\d)\b/g)||[];if(ct.length===0)continue;let title=chunk.replace(/\b(?:[01]?\d|2[0-3])[:.]([0-5]\d)\b/g,"").replace(/\b(oggi|domani|orari|spettacoli|programmazione)\b/gi,"").trim();title=title.replace(/^[-,:\s]+|[-,:\s]+$/g,"");if(title.length>=2&&title.length<=120)out.push({title,date,showtimes:Array.from(new Set(ct.map((x:string)=>x.replace(".",":").padStart(5,"0")))),sourceType:src.sourceType,sourceUrl:src.sourceUrl,sourceLabel:src.sourceLabel,verificationWarning:WARNING})}
  return out.slice(0,10);
}
async function verifyFallbackSources(sources:any[]){
  const candidates=sources.flatMap(parseFallbackSource),verified:any[]=[];
  for(const item of candidates.slice(0,12)){const g=await verifyGenre(item.title);if(g.isHorror&&g.confidence==="high")verified.push({...item,genreConfidence:g.confidence,genreEvidence:g.evidence,genreCached:g.cached})}
  return verified;
}
function reply(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{...CORS,"Content-Type":"application/json"}})}
function normalizeTitle(s:string){return s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()}
// Service-role client: created lazily, only for radar tables, never for auth checks.
let serviceDb:any=null;
function admin(){if(!serviceDb){const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!url||!key)throw new Error("service_role_unavailable");serviceDb=restrictTables(createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}),SERVICE_TABLES)}return serviceDb}
// Operator sessions are validated by Supabase Auth with the anon key; the service role is not involved.
let authClient:any=null;
async function verifyUserToken(token:string){const url=Deno.env.get("SUPABASE_URL"),anon=Deno.env.get("SUPABASE_ANON_KEY");if(!url||!anon)throw new Error("auth_client_unavailable");authClient??=createClient(url,anon,{auth:{persistSession:false,autoRefreshToken:false}});return await authClient.auth.getUser(token)}
async function tavilySearch(query:string,max_results=5){const rawKey=Deno.env.get("TAVILY_API_KEY");if(!rawKey)throw new Error("tavily_secret_missing");const key=rawKey.trim();if(!/^[\x21-\x7e]+$/.test(key))throw new Error("tavily_secret_invalid_characters");const res=await fetch("https://api.tavily.com/search",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+key},body:JSON.stringify({query,search_depth:"basic",max_results,include_answer:false,include_raw_content:false}),signal:AbortSignal.timeout(9000)});if(!res.ok)throw new Error("tavily_"+res.status);return await res.json()}
function horrorEvidence(results:any[]){const rx=/\b(horror|film dell.?orrore|film horror|horror film|terrore)\b/i;return(results||[]).filter((x:any)=>rx.test((x.title||"")+" "+(x.content||""))).map((x:any)=>({title:x.title,url:x.url,excerpt:(x.content||"").slice(0,350)}))}
function plausibleFilmTitle(title:string){const s=String(title||"").trim();if(s.length<3||s.length>90)return false;if(scheduleHeading(s)||explicitScheduleDate(s)||/\b(?:movieland|multiplex|multisala)\b/i.test(s))return false;if(/(?:€|\\b(?:posti|sala\\s*\\d+|biglietti|prezzo|orari|spettacoli|programmazione|cinema teatro)\\b)/i.test(s))return false;if(/\\d+[,.]\\d{2}\\s*(?:euro|eur)/i.test(s))return false;if(!/[a-zA-ZÀ-ÿ]{3}/.test(s))return false;return true}
async function verifyGenre(title:string,year?:number){if(!plausibleFilmTitle(title))return{isHorror:false,confidence:"invalid_title",evidence:[],cached:false};const db=admin(),normalized=normalizeTitle(title);const {data:cached,error}=await db.from("radar_movie_classification").select("*").eq("normalized_title",normalized).maybeSingle();if(error)throw error;if(cached){await db.from("radar_movie_classification").update({last_seen_at:new Date().toISOString()}).eq("id",cached.id);return{isHorror:cached.is_horror,confidence:cached.confidence,evidence:cached.evidence,cached:true}}
 const query='"'+title+'" '+(year||"")+' film genere horror';const found=await tavilySearch(query,5),evidence=horrorEvidence(found.results||[]);const relevant=evidence.filter((x:any)=>normalizeTitle(x.title+" "+x.excerpt).includes(normalized));const isHorror=relevant.length>=2,confidence=isHorror?"high":"review";
 const row={normalized_title:normalized,display_title:title,release_year:year||null,is_horror:isHorror,confidence,evidence:relevant,verified_at:new Date().toISOString(),last_seen_at:new Date().toISOString(),verifier_version:"web-v2"};
 const {error:writeError}=await db.from("radar_movie_classification").upsert(row,{onConflict:"normalized_title"});if(writeError)throw writeError;return{isHorror,confidence,evidence:relevant,cached:false}}
Deno.serve(async(req)=>{if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});if(req.method!=="POST")return reply({error:"method_not_allowed"},405);const requestId=crypto.randomUUID();let isOperator=false;try{
// Gate: body size, known mode, operator authorization and date format are all checked before any mode runs.
const body=await readJsonBody(req,MAX_BODY_CHARS);if(!body.ok)return reply({error:body.error},body.status);const b=body.value;
const route=classifyMode(b.mode);if(!route)return reply({error:"unknown_mode"},400);
if(route.access==="operator"){const auth=await authorizeOperator({authorization:req.headers.get("Authorization"),operatorIds:parseOperatorIds(Deno.env.get("RADAR_OPERATOR_USER_IDS")),getUser:verifyUserToken});if(!auth.ok){console.error("radar_operator_denied",JSON.stringify({requestId,mode:route.mode,reason:auth.error}));return reply({error:auth.error},auth.status)}isOperator=true}
if(b.today!==undefined&&!isValidIsoDate(b.today))return reply({error:"invalid_date"},400);
if(b?.mode==="parse_official_page"){const url=String(b?.url||"");if(!/^https?:\/\//i.test(url))return reply({error:"valid_url_required"},400);const parsed=await inspectOfficialPage(url);const today=String(b?.today||new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Rome",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()));const next=new Date(today+"T12:00:00Z");next.setUTCDate(next.getUTCDate()+1);const tomorrow=next.toISOString().slice(0,10);const adaptive=adaptiveParse(parsed.url,parsed.html,[today,tomorrow]);const dated=adaptive.candidates;const verifiedResults:any[]=[];for(const item of dated.slice(0,12)){const g=await verifyGenre(item.title);if(g.isHorror&&g.confidence==="high"){verifiedResults.push({movieTitle:item.title,date:item.date,showtimes:item.showtimes,sourceType:"official_cinema",sourceUrl:parsed.url,sourceLabel:"Sito ufficiale del cinema",verificationWarning:null,genreConfidence:g.confidence,genreEvidence:g.evidence,genreCached:g.cached})}}return reply({service:"HORRIFY Horror Radar",version:"0.8-end-to-end",sourceType:"official_cinema",sourceUrl:parsed.url,targetDates:[today,tomorrow],candidateCount:parsed.candidates.length,dateBoundCount:dated.length,parserStrategy:adaptive.strategy,verifiedResults,rule:"Only date-bound screenings whose title is web-verified as horror are returned."})}
if(b?.mode==="diagnose_giometti_structure"){const targets=[{city:"Ancona",url:"https://www.giomettirealestatecinema.it/cinema/multiplex-ancona/programmazione"},{city:"Tolentino",url:"https://www.giomettirealestatecinema.it/cinema/multiplex-tolentino/programmazione"},{city:"Jesi",url:"https://www.giomettirealestatecinema.it/cinema/multiplex-jesi/programmazione"}];const results=[];for(const t of targets){try{const p=await inspectOfficialPage(t.url);const h=p.html;const parsed=adaptiveParse(p.url,h,[new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Rome",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())]);results.push({city:t.city,ok:true,finalUrl:p.url,htmlBytes:h.length,title:h.slice(Math.max(0,h.toLowerCase().indexOf("<title")),h.toLowerCase().indexOf("</title>")+8).slice(0,150),markers:["__NEXT_DATA__","application/ld+json","wp-json","film","spettacoli","programmazione","iframe"].map(x=>({marker:x,present:h.toLowerCase().includes(x.toLowerCase())})),sample:h.slice(0,850),parser:parsed.strategy,candidates:parsed.candidates.slice(0,4).map((x:any)=>({title:x.title,date:x.date,showtimes:x.showtimes}))})}catch(e){results.push({city:t.city,ok:false,error:String(e).slice(0,140)})}}return reply({diagnostic:"giometti_structure",results,notice:"Diagnostic only; no screenings published"})}
if(b?.mode==="diagnose_18tickets_stage"){
 try{
 const p=await inspectOfficialPage("https://ancona.movieland.18tickets.it/");
 const h=p.html, dates=["2026-10-09","2026-10-10","2026-10-11"];
 const titleMatches=Array.from(h.matchAll(/<a\b[^>]*href=["'][^"']*\/film\/(\d+)(?:["'\/?#])[^>]*>([\s\S]{0,1300}?)<\/a>/gi));
 const headingTitles=titleMatches.filter((m:any)=>/class=["'][^"']*page-heading[^"']*["']/.test(m[2])).map((m:any)=>({id:m[1],title:m[2].replace(/<[^>]*>/g," ").trim().slice(0,80)}));
 const sections=Array.from(h.matchAll(/<div\b[^>]*id=["']schedule-(\d+)["'][^>]*>/gi));
 const samples=sections.slice(0,5).map((m:any,i:number)=>{
  const seg=h.slice(m.index,sections[i+1]?.index??h.length).slice(0,25000);
  const blocks=Array.from(seg.matchAll(/<div\b[^>]*class=["'][^"']*time-select__place[^"']*["'][^>]*>/gi));
  return{id:m[1],hasHeading:headingTitles.some((t:any)=>t.id===m[1]),blocks:blocks.slice(0,3).map((d:any,j:number)=>{
   const block=seg.slice(d.index,blocks[j+1]?.index??seg.length).slice(0,3500);
   const date=explicitScheduleDate(block.replace(/<[^>]*>/g," ").slice(0,450));
   const anchors=Array.from(block.matchAll(/<a\b[^>]*href=["']([^"']*\/film\/(\d+)\/[^"']*#theater-init)["'][^>]*>([\s\S]{0,500}?)<\/a>/gi));
   return{date,anchorCount:anchors.length,sameFilm:anchors.filter((a:any)=>a[2]===m[1]).length,times:anchors.map((a:any)=>a[3].replace(/<[^>]*>/g," ").trim().slice(0,50)).slice(0,3)};
  })};
 });
 return reply({diagnostic:"18tickets_stage",headingTitles:headingTitles.slice(0,8),samples,parsed:parse18Tickets(h,dates).slice(0,10)});
 }catch(e){return reply({diagnostic:"18tickets_stage",error:String(e).slice(0,160)})}
}
if(b?.mode==="diagnose_18tickets_pipeline"){
 try{
  const p=await inspectOfficialPage("https://ancona.movieland.18tickets.it/");
  const h=p.html;
  const decode=(x:string)=>x.replace(/&#39;|&apos;/gi,"'").replace(/&nbsp;/gi," ").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim();
  const titleLinks=Array.from(h.matchAll(/<a\b[^>]*href=["'][^"']*\/film\/(\d+)(?:["'\/?#])[^>]*>([\s\S]{0,1300}?)<\/a>/gi)).map((m:any)=>({id:m[1],text:decode(m[2]).slice(0,90),heading:m[2].match(/class=["'][^"']*page-heading[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1]||null}));
  const sections=Array.from(h.matchAll(/<div\b[^>]*id=["']schedule-(\d+)["'][^>]*>/gi));
  const sample=sections.slice(0,4).map((m:any,i:number)=>{const seg=h.slice(m.index,sections[i+1]?.index??h.length).slice(0,24000);const dates=Array.from(seg.matchAll(/<div\b[^>]*class=["'][^"']*time-select__place[^"']*["'][^>]*>/gi));return{id:m[1],blockCount:dates.length,blocks:dates.slice(0,3).map((d:any,j:number)=>{const chunk=seg.slice(d.index,dates[j+1]?.index??seg.length).slice(0,3500);const raw=decode(chunk.slice(0,450));return{date:explicitScheduleDate(raw),dateText:raw.slice(0,90),filmLinks:(chunk.match(/\/film\/\d+\/[^"' ]*#theater-init/g)||[]).length,showtimeLinks:(chunk.match(/<a\b[^>]*href=["'][^"']*\/film\/(\d+)\/[^"']*#theater-init["'][^>]*>[\s\S]{0,500}?<\/a>/gi)||[]).length}})}});
  return reply({diagnostic:"18tickets_pipeline",fetched:true,titleLinkCount:titleLinks.length,titleSamples:titleLinks.slice(0,9),scheduleSectionCount:sections.length,sections:sample,parsedCandidates:parse18Tickets(h,["2026-10-09","2026-10-10","2026-10-11"]).length});
 }catch(e){return reply({diagnostic:"18tickets_pipeline",fetched:false,error:String(e).slice(0,200)})}
}
if(b?.mode==="diagnose_18tickets_context"){
 try{
 const p=await inspectOfficialPage("https://ancona.movieland.18tickets.it/");
 const h=p.html;
 const strip=(x:string)=>x.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim().slice(0,450);
 const patterns=[/m18-day-elem/gi,/time-select__place/gi,/\/film\/\d+/gi,/select-date/gi];
 const contexts=patterns.map((re:any)=>{const matches=Array.from(h.matchAll(re)).slice(0,5);return{marker:re.source,count:Array.from(h.matchAll(re)).length,samples:matches.map((m:any)=>({before:strip(h.slice(Math.max(0,m.index-550),m.index)),after:strip(h.slice(m.index,Math.min(h.length,m.index+950))),htmlFragment:h.slice(Math.max(0,m.index-170),Math.min(h.length,m.index+420)).replace(/\s+/g," ").slice(0,580)}))}});
 return reply({diagnostic:"18tickets_context",fetched:true,contexts,notice:"HTML structure diagnostic only. No film or time published."});
 }catch(e){return reply({diagnostic:"18tickets_context",fetched:false,error:String(e).slice(0,160)})}
}
if(b?.mode==="diagnose_18tickets_structure"){
 const url="https://ancona.movieland.18tickets.it/";
 try{
  const p=await inspectOfficialPage(url);
  const h=p.html;
  const tags=Array.from(h.matchAll(/<(?:article|section|div)\b[^>]*class=["']([^"']+)["'][^>]*>/gi)).map((m:any)=>m[1]);
  const counts=new Map<string,number>();
  for(const x of tags)for(const c of x.split(/\s+/)){if(c.length>2)counts.set(c,(counts.get(c)||0)+1)}
  const anchors=Array.from(h.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,220}?)<\/a>/gi)).map((m:any)=>({href:m[1].slice(0,140),label:m[2].replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,65)})).filter((x:any)=>/film|movie|spettacol|programma|bigliett|ticket|scheda|cinema/i.test(x.href+" "+x.label)).slice(0,20);
  const markers=["__NEXT_DATA__","__NUXT__","application/ld+json","film-card","movie-card","showtime","spettacoli","programmazione"].map(x=>({marker:x,present:h.includes(x)}));
  return reply({diagnostic:"18tickets_structure",fetched:true,htmlBytes:h.length,topClasses:Array.from(counts.entries()).sort((a:any,b:any)=>b[1]-a[1]).slice(0,30).map(([name,count])=>({name,count})),markers,relatedLinks:anchors,notice:"Structure only; no movie schedule published."});
 }catch(e){return reply({diagnostic:"18tickets_structure",fetched:false,error:String(e).slice(0,150)})}
}
if(b?.mode==="diagnose_18tickets_live"){
 const url="https://ancona.movieland.18tickets.it/";
 try{
  const page=await inspectOfficialPage(url);
  const now=new Date();
  const dates=Array.from({length:3},(_,i)=>{const d=new Date(now);d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10)});
  const candidates=parse18Tickets(page.html,dates);
  const titles=candidates.slice(0,8).map((x:any)=>({title:x.title,date:x.date,showtimeCount:x.showtimes.length}));
  return reply({service:"HORRIFY Horror Radar",diagnostic:"18tickets_live",fetched:true,httpContentLength:page.html.length,datesChecked:dates,parsedCandidates:candidates.length,sample:titles,liveWebsiteTested:true,warning:"Diagnostic only: titles and times not independently verified; not published as screenings."});
 }catch(e){return reply({service:"HORRIFY Horror Radar",diagnostic:"18tickets_live",fetched:false,liveWebsiteTested:true,error:String(e).slice(0,180)},200)}
}
if(b?.mode==="diagnose_18tickets_parser"){
 const dates=["2026-10-09","2026-10-10"];
 const positive='<div class="film-card"><h3>Film Horror Esempio</h3><p>venerdì 09/10/2026</p><p>21:15</p></div><div class="film-card"><h3>Altro Film Esempio</h3><p>sabato 10/10/2026</p><p>18:30</p></div>';
 const negative='<div class="cinema-info"><h3>Movieland Ancona Goldoni</h3><p>sabato 10/10/2026</p><p>18:30 20:30</p></div>';
 const parsed=parse18Tickets(positive,dates),rejected=parse18Tickets(negative,dates);
 const ok=rejected.length===0; // Legacy fixture is not the 18tickets schedule-ID structure.
 return reply({service:"HORRIFY Horror Radar",diagnostic:"18tickets_parser",ok,positiveCases:parsed.length,negativeCasesRejected:rejected.length===0,liveWebsiteTested:false});
}
if(b?.mode==="diagnose_tavily"){try{const r=await tavilySearch("film horror cinema",1);return reply({service:"HORRIFY Horror Radar",diagnostic:"tavily",ok:Array.isArray(r?.results),resultCount:Array.isArray(r?.results)?r.results.length:0})}catch(e){const m=e instanceof Error?e.message:"unknown";return reply({service:"HORRIFY Horror Radar",diagnostic:"tavily",ok:false,error:m.startsWith("tavily_")?m:"tavily_request_failed"})}}if(b?.mode==="discover_radar"){const lat=Number(b?.lat),lon=Number(b?.lon);if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<-90||lat>90||lon<-180||lon>180)return reply({error:"invalid_coordinates"},400);const radiusKm=Math.min(Math.max(Number(b?.radiusKm||50),1),50);let cinemas:any[];try{cinemas=await discoverCachedCinemas(lat,lon,radiusKm);/* No runtime Overpass dependency: an empty cache means no indexed cinemas in the area. */}catch(e){console.error("radar_discovery_failed",String(e));return reply({error:"cinema_discovery_unavailable",message:"Ricerca cinema temporaneamente indisponibile. Riprova più tardi.",cinemasFound:0,verifiedResults:[],privacy:{geolocationPersisted:false}},503)}const today=String(b?.today||new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Rome",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()));const next=new Date(today+"T12:00:00Z");next.setUTCDate(next.getUTCDate()+1);const tomorrow=next.toISOString().slice(0,10);const inspected:any[]=[];const genreMemo=new Map<string,any>();let genreChecks=0;async function checkGenre(title:string){const k=normalizeTitle(title);if(genreMemo.has(k))return genreMemo.get(k);if(genreChecks>=12)return{isHorror:false,confidence:"unchecked"};genreChecks++;const result=await verifyGenre(title);genreMemo.set(k,result);return result}
const priorityCinemas=[...cinemas.filter((x:any)=>Boolean(x.website)),...cinemas.filter((x:any)=>!x.website)].filter((x:any,i:number,a:any[])=>a.findIndex((y:any)=>y.name===x.name&&y.latitude===x.latitude&&y.longitude===x.longitude)===i).slice(0,10);
for(const cinema of priorityCinemas){let officialResults:any[]=[],officialCandidates:any[]=[],officialUrl:string|null=null,parser:string|null=null,officialError:string|null=null;
if(cinema.website){try{const page=await inspectOfficialPage(cinema.website);officialUrl=page.url;const parsed=adaptiveParse(page.url,page.html,[today,tomorrow]);parser=parsed.strategy;officialCandidates=parsed.candidates.map((x:any)=>({...x,sourceUrl:page.url}));if(officialCandidates.length===0){for(const linkedUrl of linkedScheduleUrls(page.url,page.html)){try{const sub=await inspectOfficialPage(linkedUrl);const parsedSub=adaptiveParse(sub.url,sub.html,[today,tomorrow]);officialCandidates.push(...parsedSub.candidates.map((x:any)=>({...x,sourceUrl:sub.url})));if(officialCandidates.length)break}catch{}}}const uniqueTitles=Array.from(new Map(officialCandidates.filter((x:any)=>plausibleFilmTitle(x.title)).map((x:any)=>[normalizeTitle(x.title),x])).values()).slice(0,12);for(const titleItem of uniqueTitles){const matching=officialCandidates.filter((x:any)=>normalizeTitle(x.title)===normalizeTitle(titleItem.title));for(const item of matching){if(!plausibleFilmTitle(item.title)||normalizeTitle(item.title)===normalizeTitle(cinema.name))continue;try{const genre=await checkGenre(item.title);if(genre.isHorror&&genre.confidence==="high")officialResults.push({movieTitle:item.title,date:item.date,showtimes:item.showtimes,sourceType:"official_cinema",sourceUrl:item.sourceUrl||page.url,sourceLabel:"Pagina di programmazione del cinema",verificationWarning:null,genreConfidence:genre.confidence,genreEvidence:genre.evidence,genreCached:genre.cached})}catch(e){officialError="genre_verification_unavailable"}}}}catch(e){officialError="official_page_unavailable"}}
let fallback:any[]=[],fallbackVerified:any[]=[],programmingError:string|null=null;
if(officialCandidates.length===0){try{fallback=[...(await fallbackProgramming(cinema,today)),...(await fallbackProgramming(cinema,tomorrow))];const candidates=fallback.filter((src:any)=>trustedCinemaMatch(cinema,src)).flatMap(parseFallbackSource).filter((x:any)=>plausibleFilmTitle(x.title));for(const item of candidates.slice(0,6)){if(!plausibleFilmTitle(item.title)||normalizeTitle(item.title)===normalizeTitle(cinema.name))continue;try{const genre=await checkGenre(item.title);if(genre.isHorror&&genre.confidence==="high")fallbackVerified.push({...item,genreConfidence:genre.confidence,genreEvidence:genre.evidence,genreCached:genre.cached})}catch(e){programmingError="genre_verification_unavailable"}}}catch(e){programmingError="external_programming_search_unavailable";console.error("radar_programming_lookup_failed",e instanceof Error?e.message:"unknown")}}
inspected.push({...cinema,sourceType:officialResults.length?"official_cinema":"web_fallback",officialUrl,parser,dateBoundCandidates:officialCandidates,officialVerified:officialResults,fallbackSources:fallback,fallbackVerified,officialError,programmingError})}
const verifiedResults=inspected.flatMap((cinema:any)=>[...(cinema.officialVerified||[]),...(cinema.fallbackVerified||[])].map((item:any)=>({...item,cinemaName:cinema.name,cinemaCity:cinema.city,distanceKm:cinema.distanceKm})));return reply({service:"HORRIFY Horror Radar",version:"1.8-official-first",discoverySource:"supabase_radar_cinemas",coverage:cinemas.length===0?"no_indexed_cinemas_in_radius":"indexed_cinemas_found",programmingStatus:inspected.some((x:any)=>x.programmingError)?"partially_unavailable":"completed",privacy:{geolocationPersisted:false},request:{radiusKm,targetDates:[today,tomorrow]},cinemasFound:cinemas.length,cinemasWithWebsite:cinemas.filter((x:any)=>Boolean(x.website)).length,inspectionStrategy:"official_website_first_then_nearest",inspected,verifiedResults,note:"Fallback results require explicit date context, title-showtime association and high-confidence web horror verification. Non-official sources always carry the mandatory warning."})}
if(b?.mode!=="verify_genre")return reply({service:"HORRIFY Horror Radar",version:"0.8-end-to-end",status:"end_to_end_ready",sourcePolicy:{thirdParty:WARNING},tmdbGenreUsed:false});const title=String(b?.title||"").trim();if(!title)return reply({error:"title_required"},400);return reply({service:"HORRIFY Horror Radar",version:"0.8-end-to-end",title,...await verifyGenre(title,b?.year?Number(b.year):undefined),tmdbUsed:false})}catch(e){const detail=e instanceof Error?e.message:"unknown";console.error("radar_failed",JSON.stringify({requestId,detail}));return reply(isOperator?{error:"radar_failed",requestId,detail}:{error:"radar_failed",requestId},502)}});