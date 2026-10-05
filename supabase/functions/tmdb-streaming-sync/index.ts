import {createClient} from 'npm:@supabase/supabase-js@2.57.4';
import {normalize,sameFilm,subscriptionOffers} from './core.mjs';
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
Deno.serve(async(req:Request)=>{
 if(req.method!=='POST')return json(405,{error:'method_not_allowed'});
 const syncKey=req.headers.get('x-sync-key');if(!syncKey)return json(401,{error:'unauthorized'});
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
 const {data:control,error:controlError}=await db.from('streaming_sync_control').select('secret').eq('id',1).single();
 if(controlError||control?.secret!==syncKey)return json(401,{error:'unauthorized'});
 const token=Deno.env.get('TMDB_READ_TOKEN');
 if(!token){await db.from('streaming_sync_control').update({status:'awaiting_token',last_run_at:new Date().toISOString()}).eq('id',1);return json(503,{error:'tmdb_token_missing'});}
 const check=async(result:any)=>{if(result.error)throw Error('database_error');return result.data};
 const tmdb=async(path:string)=>{const response=await fetch('https://api.themoviedb.org/3'+path,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error(response.status===401?'invalid_tmdb_token':'tmdb_unavailable');return response.json()};
 let updated=0,unmatched=0,failed=0;
 try{
 const movies=await check(await db.from('movies').select('id,title,release_year,director,tmdb_id,streaming_checked_at,streaming_attempted_at').order('streaming_attempted_at',{ascending:true,nullsFirst:true}));
 const services=await check(await db.from('streaming_services').select('id,slug').eq('active',true));
 const batch=movies.filter((m:any)=>(!m.streaming_checked_at||Date.parse(m.streaming_checked_at)<Date.now()-23*3600000)&&(!m.streaming_attempted_at||Date.parse(m.streaming_attempted_at)<Date.now()-3*3600000)).slice(0,10);
 for(const movie of batch){
 try{
 let tmdbId=movie.tmdb_id;
 if(!tmdbId){
 const found=await tmdb(`/search/movie?language=it-IT&query=${encodeURIComponent(movie.title)}&primary_release_year=${movie.release_year}&include_adult=false`);
 const candidates=(found.results||[]).filter((c:any)=>Number(String(c.release_date).slice(0,4))===movie.release_year).slice(0,5);
 const matches=[];for(const candidate of candidates){const credits=await tmdb(`/movie/${candidate.id}/credits`);if(sameFilm(movie,candidate,credits))matches.push(candidate.id)}
 if(matches.length!==1){unmatched++;await check(await db.from('movies').update({streaming_match_status:matches.length?'ambiguous':'unmatched',streaming_attempted_at:new Date().toISOString()}).eq('id',movie.id));continue}tmdbId=matches[0];
 }
 const providers=await tmdb(`/movie/${tmdbId}/watch/providers`);const italy=providers.results?.IT;
 const offers=subscriptionOffers(italy,services);if(offers.length&&(!italy.link||!italy.link.startsWith('https://www.themoviedb.org/')))throw Error('invalid_source');
 await check(await db.rpc('replace_movie_streaming_offers',{p_movie_id:movie.id,p_tmdb_id:tmdbId,p_offers:offers,p_checked_at:new Date().toISOString()}));updated++;
 }catch(error){failed++;await db.from('movies').update({streaming_match_status:'error',streaming_attempted_at:new Date().toISOString()}).eq('id',movie.id);if(error instanceof Error&&error.message==='invalid_tmdb_token')throw error;}
 }
 await check(await db.from('streaming_sync_control').update({last_run_at:new Date().toISOString(),status:failed?'partial':'ok',updated_count:updated}).eq('id',1));return json(200,{updated,unmatched,failed});
 }catch(error){const status=error instanceof Error&&error.message==='invalid_tmdb_token'?'invalid_token':'error';await db.from('streaming_sync_control').update({status,last_run_at:new Date().toISOString()}).eq('id',1);return json(502,{error:status,updated});}
});
