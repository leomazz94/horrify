/* Supabase is the authoritative catalog, shared by guests and members. */
const horrifyDb = window.supabase.createClient('https://tvhdxnxnlllmnnbszaqd.supabase.co','sb_publishable_egjNbK0FI-tEQThtPVWSxg_FzT0X8nO');
const HorrifyCatalog = (() => {
  const idFor = row => {
    const key = row.external_key?.replace(/^horrify:/,'') || `db-${row.id}`;
    return /^\d+$/.test(key) ? Number(key) : key;
  };
  const safeUrl = (value, relative=false) => {
    if (!value) return null;
    try { const url=new URL(value,location.href);return url.protocol==='https:'&&(relative||/^https:\/\//i.test(value))?value:null; } catch { return null; }
  };
  const filmFor = row => ({
    ...row.editorial_data,
    id:idFor(row),dbId:row.id,title:row.title,originalTitle:row.original_title,
    year:row.release_year,director:row.director||'Regista da verificare',
    group:row.category||'Occulto e altri cult',tomato:row.tomato,
    poster:safeUrl(row.poster_url,true),justwatchUrl:safeUrl(row.justwatch_url),
    cinemaUrl:safeUrl(row.editorial_data?.cinemaUrl),state:row.catalog_section
  });
  async function load() {
    const rows=[];
    for(let offset=0;;offset+=500){
      const {data,error}=await horrifyDb.from('movies').select('id,external_key,title,original_title,release_year,director,category,tomato,poster_url,justwatch_url,catalog_section,editorial_data').order('id').range(offset,offset+499);
      if(error)throw error;
      rows.push(...data);
      if(data.length<500)break;
    }
    return {rows,films:rows.map(filmFor)};
  }
  return {load,idFor,filmFor};
})();
