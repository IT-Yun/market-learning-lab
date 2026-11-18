const $=id=>document.getElementById(id);
let currentUser=null,pending=null;
async function api(path,{method='GET',body}={}) {
  const response=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  $('result').textContent=JSON.stringify({status:response.status,data},null,2);
  if(!response.ok)throw new Error(data.error);
  return data;
}
async function refresh(){
  const {items}=await api('/api/items');$('items').replaceChildren();
  for(const item of items){
    const row=document.createElement('li');row.textContent=`${item.title} · AUD ${(item.price_cents/100).toFixed(2)} · ${item.owner} · revision ${item.revision}`;
    if(item.owner===currentUser){const edit=document.createElement('button');edit.textContent='Edit name';edit.onclick=async()=>{const title=prompt('New item name',item.title);if(title===null)return;try{await api('/api/items/'+item.id,{method:'PATCH',body:{title,revision:item.revision}});await refresh();}catch(error){$('result').textContent+='\n'+error.message;}};row.append(edit);}
    $('items').append(row);
  }
}
$('login').onsubmit=async e=>{e.preventDefault();try{const r=await api('/api/session',{method:'POST',body:{username:$('username').value,password:$('password').value}});currentUser=r.username;pending=null;$('session').textContent=currentUser+' signed in';$('password').value='';await refresh();}catch(error){$('session').textContent=error.message;}};
$('logout').onclick=async()=>{try{await api('/api/logout',{method:'POST',body:{}});currentUser=null;pending=null;$('session').textContent='Signed out';await refresh();}catch{}};
$('create').onsubmit=async e=>{
  e.preventDefault();const title=$('title').value,raw=$('price').value;
  if(!/^\d+(\.\d{1,2})?$/.test(raw)){ $('result').textContent='Enter a price with at most two decimal places.';return; }
  const [whole,fraction='']=raw.split('.');const price_cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  const signature=JSON.stringify({title,price_cents});
  if(!pending||pending.signature!==signature)pending={signature,request_id:crypto.randomUUID()};
  $('save').disabled=true;
  try{await api('/api/items',{method:'POST',body:{title,price_cents,request_id:pending.request_id,simulate_failure:$('fault').checked}});pending=null;await refresh();}
  catch(error){$('result').textContent+='\n'+error.message;}finally{$('save').disabled=false;}
};
$('refresh').onclick=()=>refresh().catch(()=>{});
(async()=>{try{const me=await api('/api/me');currentUser=me.username;$('session').textContent=currentUser+' signed in';}catch{}await refresh();})().catch(()=>{});
