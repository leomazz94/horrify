const allowedOrigins = new Set(['https://horrify.it','https://www.horrify.it']);
export function createFeedbackHandler({db,env,fetchImpl=fetch}) { return async req => {
 const origin=req.headers.get('Origin');
 const local=origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
 const cors={'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,GET,OPTIONS','Vary':'Origin','Content-Type':'application/json','Cache-Control':'no-store'};
 if(origin && !allowedOrigins.has(origin) && !local) return new Response(JSON.stringify({error:'Origine non consentita.'}),{status:403,headers:cors});
 if(origin)cors['Access-Control-Allow-Origin']=origin;
 const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:cors});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 const apiKey=env('RESEND_API_KEY');
 if(req.method==='GET')return reply({email_configured:Boolean(apiKey)});
 if(req.method!=='POST')return reply({error:'Metodo non consentito.'},405);
 const auth=req.headers.get('Authorization')||'';
 if(!/^Bearer\s+\S+$/i.test(auth))return reply({error:'Accedi per inviare un commento.'},401);
 try {
  const {data:{user},error:authError}=await db.auth.getUser(auth.replace(/^Bearer\s+/i,''));
  if(authError||!user||user.is_anonymous||!user.email||!user.email_confirmed_at)return reply({error:'Accedi con un account confermato per inviare un commento.'},401);
  const text=await req.text();if(text.length>24000)return reply({error:'Il commento è troppo lungo.'},400);
  let body;try{body=JSON.parse(text)}catch{return reply({error:'Richiesta non valida.'},400)}
  const message=typeof body.message==='string'?body.message.trim():'';
  if(message.length<10||message.length>5000||!['suggestion','request','bug'].includes(body.category)||typeof body.request_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id))return reply({error:'Scrivi un commento tra 10 e 5000 caratteri e scegli un tipo valido.'},400);
  const {data:row,error:insertError}=await db.from('user_feedback').insert({user_id:user.id,user_email:user.email,request_id:body.request_id,category:body.category,message}).select('id').single();
  if(insertError){
   if(insertError.code==='23505')return reply({ok:true});
   if(insertError.message.includes('feedback_rate_limited'))return reply({error:'Hai già inviato tre commenti. Attendi qualche minuto prima di inviarne un altro.'},429);
   return reply({error:'Non riesco a salvare il commento. Riprova tra poco.'},503);
  }
  if(apiKey){
   try{
    const {data:config,error:configError}=await db.from('feedback_delivery_config').select('recipient').eq('id',true).single();
    if(configError||!config?.recipient)throw Error('delivery_config_missing');
    const labels={suggestion:'Consiglio',request:'Richiesta',bug:'Problema'};
    const response=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':`feedback-${row.id}`},body:JSON.stringify({from:env('FEEDBACK_FROM_EMAIL')||'HORRIFY <onboarding@resend.dev>',to:[config.recipient],reply_to:user.email,subject:`HORRIFY · ${labels[body.category]}`,text:`Nuovo commento privato da ${user.email}\nTipo: ${labels[body.category]}\n\n${message}\n\nRiferimento: ${row.id}`}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error('email_failed');
    await db.from('user_feedback').update({email_status:'sent',email_sent_at:new Date().toISOString()}).eq('id',row.id);
   }catch{await db.from('user_feedback').update({email_status:'failed'}).eq('id',row.id)}
  }
  return reply({ok:true});
 }catch{return reply({error:'Invio non riuscito. Riprova tra poco.'},503)}};}
