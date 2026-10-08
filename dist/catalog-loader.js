/* Refresh without deployment, preserving search and selected filters. */
(() => {
  let inFlight=null,loaded=false,discoveryMeta={checkedAt:'2026-10-01',cinemaValidUntil:'2026-10-07'},manualCinema=[];
  const notice=document.getElementById('catalog-message');
  async function refresh(){
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      try{
        const data=await HorrifyCatalog.load();
        catalogFilms=data.films;
        baseFilms=catalogFilms.filter(f=>f.state==='archive');
        // Temporary nationwide cinema listings come exclusively from the manually verified JSON.
        // Supabase may still contain expired cinema entries; do not merge those into Horror Radar.
        renderDiscovery({...discoveryMeta,movies:[...manualCinema,...catalogFilms.filter(f=>f.state==='demand')]});
        accounts.updateCatalog(data.rows);
        loaded=true;notice.hidden=true;
      }catch{
        notice.hidden=false;
        notice.textContent=loaded?'Aggiornamento del catalogo non riuscito. Mostriamo l’ultima versione caricata; riproveremo automaticamente.':'Non riesco a leggere il catalogo da Supabase. Riprova tra poco o ricarica la pagina.';
        if(!loaded)list.innerHTML='<p class="empty">Catalogo temporaneamente non disponibile.</p>';
      }
    })().finally(()=>{inFlight=null});
    return inFlight;
  }
  Promise.all([
    fetch('./discovery.json',{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject()).then(({movies,...meta})=>{discoveryMeta=meta;manualCinema=(movies||[]).filter(f=>f.state==='cinema')}).catch(()=>{}),
    fetch('./film-clues.json').then(r=>r.ok?r.json():Promise.reject()).then(data=>{clues=data}).catch(()=>{})
  ]).then(refresh);
  setInterval(()=>{if(!document.hidden)refresh()},60000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
})();
