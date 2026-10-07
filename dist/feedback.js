/* Private feedback from confirmed HORRIFY accounts. */
(()=>{
 const form=document.getElementById('feedback-form'),gate=document.getElementById('feedback-login'),notice=document.getElementById('feedback-status'),button=document.getElementById('feedback-submit');
 let request=null,lastUser=null;
 const status=(text,kind='')=>{notice.textContent=text;notice.className='feedback-status'+(kind?' '+kind:'')};
 function sync(){const id=accounts.user?.id||null;gate.hidden=!!id;form.hidden=!id;if(id!==lastUser){form.reset();request=null;status('');lastUser=id}}
 document.getElementById('feedback-signin').onclick=()=>document.getElementById('account-open').click();
 document.addEventListener('horrify-account-change',sync);sync();
 form.onsubmit=async event=>{
  event.preventDefault();const userId=accounts.user?.id;if(!userId){sync();return}
  const message=document.getElementById('feedback-comment').value.trim(),category=document.getElementById('feedback-category').value;
  if(message.length<10||message.length>5000){status('Scrivi un commento tra 10 e 5000 caratteri.','error');return}
  const signature=JSON.stringify({message,category,userId});if(request?.signature!==signature)request={signature,id:crypto.randomUUID()};
  button.disabled=true;status('Invio in corso…');
  try{
   const {data,error}=await horrifyDb.functions.invoke('submit-feedback',{body:{message,category,request_id:request.id}});
   if(error){let detail;try{detail=(await error.context?.json())?.error}catch{}throw Error(detail||'Non riesco a inviare il commento. Riprova tra poco.')}
   if(!data?.ok)throw Error('Non riesco a inviare il commento. Riprova tra poco.');
   if(accounts.user?.id===userId){form.reset();request=null;status('Grazie! Il tuo commento è stato ricevuto in privato. Ci aiuterà a migliorare HORRIFY.','success')}
  }catch(error){if(accounts.user?.id===userId)status(error.message||'Invio non riuscito. Riprova.','error')}
  finally{button.disabled=false}
 };
})();
