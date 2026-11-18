import http from 'node:http';
import { pathToFileURL } from 'node:url';
export function createProvider({port=4320,key,delayMs=0}) {
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    const respond=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    if(req.headers['x-api-key']!==key)return respond(401,{error:'invalid_provider_key'});
    if(url.pathname!=='/quote')return respond(404,{error:'not_found'});
    const subtotal=Number(url.searchParams.get('subtotal'));
    if(!url.searchParams.has('subtotal')||!Number.isSafeInteger(subtotal)||subtotal<0)return respond(400,{error:'invalid_subtotal'});
    setTimeout(()=>respond(200,{shipping_cents:subtotal>=5000?0:800,currency:'AUD',synthetic:true}),delayMs);
  });
  return {server,async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return 'http://127.0.0.1:'+server.address().port;},async close(){await new Promise(r=>server.close(r));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.env.SHIPPING_API_KEY)throw Error('Missing SHIPPING_API_KEY');
  const provider=createProvider({key:process.env.SHIPPING_API_KEY,delayMs:Number(process.env.SHIPPING_DELAY_MS||0)});
  console.log('Synthetic provider ready: '+await provider.listen());
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await provider.close();process.exit(0);});
}
