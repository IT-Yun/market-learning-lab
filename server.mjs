import http from 'node:http';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openStore } from './db.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a,b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
function fail(status, code) { throw Object.assign(new Error(code), { status, code }); }

export function createLab(config) {
  const db = openStore(config.dbPath);
  const attempts = new Map();
  let origin;
  const server = http.createServer(async (req,res) => {
    const requestId = randomUUID();
    const send = (status,body,headers={}) => {
      res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8',
        'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
        'X-Request-Id':requestId, ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.host !== new URL(origin).host) fail(421,'unexpected_host');
      const url = new URL(req.url,origin);
      const method = req.method;
      if (['POST','PATCH','DELETE'].includes(method)) {
        if (req.headers.origin !== origin) fail(403,'origin_not_allowed');
        if (!String(req.headers['content-type']).startsWith('application/json')) fail(415,'json_required');
      }
      const body = async () => {
        let size=0, chunks=[];
        for await (const chunk of req) {
          size+=chunk.length;
          if(size>16384) fail(413,'body_too_large');
          chunks.push(chunk);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString()); }
        catch { fail(400,'invalid_json'); }
      };
      const user = () => {
        const token = /(?:^|;\s*)sid=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
        const row=token && db.prepare('SELECT username FROM sessions WHERE hash=? AND expires>?').get(hash(token),Date.now());
        if(!row) fail(401,'login_required');
        return row.username;
      };
      if(method==='GET' && url.pathname==='/api/health') return send(200,{ok:true,service:'market-learning-lab'});
      if(method==='GET' && url.pathname==='/api/diagnostics') {
        if(!config.readToken || !equal(req.headers.authorization||'',`Bearer ${config.readToken}`)) fail(401,'read_token_required');
        return send(200,{itemCount:db.prepare('SELECT count(*) AS n FROM items').get().n,
          auditCount:db.prepare('SELECT count(*) AS n FROM audit').get().n});
      }
      if(method==='GET' && url.pathname==='/api/shipping') {
        const subtotal=Number(url.searchParams.get('subtotal'));
        if(!url.searchParams.has('subtotal')||!Number.isSafeInteger(subtotal)||subtotal<0) fail(400,'invalid_subtotal');
        if(!config.shippingUrl||!config.shippingKey) fail(503,'provider_not_configured');
        const target=new URL(config.shippingUrl);
        if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password) fail(503,'invalid_provider_config');
        const endpoint=new URL('/quote',target);endpoint.searchParams.set('subtotal',String(subtotal));
        let upstream;
        try{upstream=await fetch(endpoint,{headers:{'X-API-Key':config.shippingKey},signal:AbortSignal.timeout(config.shippingTimeout||800),redirect:'error'});}
        catch(error){fail(error.name==='TimeoutError'?504:502,error.name==='TimeoutError'?'provider_timeout':'provider_unreachable');}
        if(!upstream.ok)fail(502,'provider_http_'+upstream.status);
        let quote;try{quote=await upstream.json();}catch{fail(502,'provider_invalid_json');}
        if(!quote||!Number.isSafeInteger(quote.shipping_cents)||quote.shipping_cents<0||quote.currency!=='AUD'||quote.synthetic!==true)fail(502,'provider_invalid_schema');
        return send(200,{shipping_cents:quote.shipping_cents,currency:quote.currency,synthetic:true});
      }
      if(method==='POST' && url.pathname==='/api/session') {
        const key=req.socket.remoteAddress;
        const entry=attempts.get(key)||{count:0,until:0};
        if(entry.until<Date.now()){entry.count=0;entry.until=Date.now()+60000;}
        entry.count++;attempts.set(key,entry);
        if(entry.count>10) fail(429,'try_later');
        const input=await body();
        if(!input||!['alice','bob'].includes(input.username)||typeof input.password!=='string'||!equal(input.password,config.password)) fail(401,'invalid_login');
        const token=randomBytes(24).toString('hex');
        db.prepare('INSERT INTO sessions(hash,username,expires) VALUES(?,?,?)').run(hash(token),input.username,Date.now()+3600000);
        return send(200,{username:input.username},{'Set-Cookie':`sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`});
      }
      if(method==='POST' && url.pathname==='/api/logout') {
        user();
        const token=/(?:^|;\s*)sid=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
        db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token));
        return send(200,{ok:true},{'Set-Cookie':'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
      }
      if(method==='GET' && url.pathname==='/api/me') return send(200,{username:user()});
      if(method==='GET' && url.pathname==='/api/items') {
        return send(200,{items:db.prepare('SELECT id,owner,title,price_cents,revision FROM items ORDER BY rowid DESC').all()});
      }
      if(method==='POST' && url.pathname==='/api/items') {
        const owner=user(), input=await body();
        if(!input||Object.keys(input).some(k=>!['title','price_cents','request_id','simulate_failure'].includes(k))) fail(400,'unknown_field');
        if(typeof input.title!=='string'||!input.title.trim()||input.title.trim().length>80) fail(400,'invalid_title');
        if(!Number.isSafeInteger(input.price_cents)||input.price_cents<0||input.price_cents>10000000) fail(400,'invalid_price');
        if(typeof input.request_id!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.request_id)) fail(400,'invalid_request_id');
        const old=db.prepare('SELECT * FROM items WHERE owner=? AND request_id=?').get(owner,input.request_id);
        if(old) {
          if(old.title!==input.title.trim()||old.price_cents!==input.price_cents) fail(409,'request_id_payload_mismatch');
          return send(200,{id:old.id,replayed:true});
        }
        const id=randomUUID();
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO items(id,owner,title,price_cents,request_id) VALUES(?,?,?,?,?)').run(id,owner,input.title.trim(),input.price_cents,input.request_id);
          // Deliberate, local-only fault for the transaction exercise.
          if(input.simulate_failure===true) fail(503,'simulated_failure_before_audit');
          db.prepare('INSERT INTO audit(item_id,action,actor) VALUES(?,?,?)').run(id,'created',owner);
          db.exec('COMMIT');
        } catch(error) { db.exec('ROLLBACK');throw error; }
        return send(201,{id,replayed:false});
      }
      const match=/^\/api\/items\/([a-f0-9-]{36})$/.exec(url.pathname);
      if(method==='PATCH' && match) {
        const owner=user(),input=await body(),id=match[1];
        const item=db.prepare('SELECT * FROM items WHERE id=?').get(id);
        if(!item) fail(404,'item_not_found');
        if(item.owner!==owner) fail(403,'not_owner');
        if(!input||Object.keys(input).some(k=>!['title','revision'].includes(k))) fail(400,'unknown_field');
        if(typeof input.title!=='string'||!input.title.trim()||input.title.trim().length>80) fail(400,'invalid_title');
        if(!Number.isSafeInteger(input.revision)) fail(400,'invalid_revision');
        const result=db.prepare('UPDATE items SET title=?, revision=revision+1 WHERE id=? AND owner=? AND revision=?').run(input.title.trim(),id,owner,input.revision);
        if(result.changes!==1) fail(409,'stale_revision');
        return send(200,{id,revision:item.revision+1});
      }
      const staticFiles={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/styles.css':['styles.css','text/css']};
      if(method==='GET'&&staticFiles[url.pathname]) {
        const [file,type]=staticFiles[url.pathname];
        res.writeHead(200,{'Content-Type':type+'; charset=utf-8','X-Content-Type-Options':'nosniff',
          'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"});
        return res.end(await readFile(new URL('./public/'+file,import.meta.url)));
      }
      fail(404,'not_found');
    } catch(error) {
      // Only error codes and request IDs are logged. Never log passwords/cookies.
      const status=error.status||500;
      console.error(JSON.stringify({requestId,status,code:error.code||'internal_error'}));
      send(status,{error:error.code||'internal_error',requestId});
    }
  });
  return {server,db,async listen(){
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',resolve);});
    origin=`http://127.0.0.1:${server.address().port}`;return origin;
  },async close(){await new Promise(resolve=>server.close(resolve));db.close();}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const port=Number(process.env.PORT);
  if(process.env.HOST!=='127.0.0.1'||!Number.isInteger(port)||port<1024||port>65535||!process.env.DB_PATH||!process.env.LAB_PASSWORD||!process.env.MCP_READ_TOKEN){
    console.error('Invalid/missing local config. Run npm run setup and read .env.example.');process.exit(1);
  }
  const app=createLab({port,dbPath:process.env.DB_PATH,password:process.env.LAB_PASSWORD,readToken:process.env.MCP_READ_TOKEN,shippingUrl:process.env.SHIPPING_API_URL,shippingKey:process.env.SHIPPING_API_KEY,shippingTimeout:Number(process.env.SHIPPING_TIMEOUT_MS||800)});
  try{console.log('Lab ready: '+await app.listen());}
  catch(error){console.error(error.code==='EADDRINUSE'?'Port already in use. Choose a free PORT; do not kill an unrelated service.':error.code);process.exitCode=1;app.db.close();}
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
}
