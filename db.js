/* فريق أوسكار البرمجي — طبقة بيانات Turso مبسطة بدون مزامنة قديمة.
   Turso هو المصدر الرئيسي لبيانات المتجر المشتركة، وIndexedDB كنسخة محلية احتياطية فقط. */
window.DB = (() => {
  const tables=['products','categories','orders','users','carts','favorites','coupons','offers','banners','testimonials','faq','notifications','audit','settings'];
  const sharedTables=new Set(['products','categories','coupons','offers','banners','testimonials','faq','notifications','settings']);
  const cfg=window.OSCAR_TURSO_CONFIG||{};
  const localName='oscar-market-v3-turso-direct';
  let db=null, cloudError='', schemaPromise=null;

  const isAdminPage=()=>/\badmin\.html$/i.test(location.pathname)||location.hash.startsWith('#/admin');
  const storedAdminToken=()=>{try{return sessionStorage.getItem('oscar-turso-admin-token')||''}catch{return ''}};
  const readToken=()=>String(cfg.readToken||cfg.directToken||cfg.adminToken||storedAdminToken()||'').trim();
  const directToken=()=>String(cfg.directToken||cfg.adminToken||storedAdminToken()||'').trim();
  const writeToken=()=>directToken();
  const canWriteCloud=()=>isAdminPage()&&!!writeToken();
  const endpoint=()=>String(cfg.url||'').replace(/^libsql:\/\//i,'https://').replace(/\/$/,'')+'/v2/pipeline';

  function openLocal(){
    return new Promise((resolve,reject)=>{
      const r=indexedDB.open(localName,1);
      r.onupgradeneeded=()=>tables.forEach(t=>{if(!r.result.objectStoreNames.contains(t))r.result.createObjectStore(t,{keyPath:'id'})});
      r.onsuccess=()=>{db=r.result;resolve(db)};
      r.onerror=()=>reject(new Error('تعذر فتح التخزين المحلي'));
      r.onblocked=()=>reject(new Error('أغلق النسخ الأخرى من المتجر ثم حاول مجدداً'));
    });
  }
  function transaction(names,mode,fn){
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(names,mode);let result;
      try{result=fn(tx)}catch(e){try{tx.abort()}catch{}reject(e);return}
      tx.oncomplete=()=>resolve(typeof result==='function'?result():result);
      tx.onerror=()=>reject(tx.error||new Error('تعذر إكمال العملية المحلية'));
      tx.onabort=()=>reject(tx.error||new Error('تعذر إكمال العملية المحلية'));
    });
  }
  const localAll=t=>new Promise((resolve,reject)=>{const r=db.transaction(t).objectStore(t).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error)});
  const localGet=(t,id)=>new Promise((resolve,reject)=>{const r=db.transaction(t).objectStore(t).get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const localPut=(t,row)=>transaction(t,'readwrite',tx=>tx.objectStore(t).put(row));
  const localDel=(t,id)=>transaction(t,'readwrite',tx=>tx.objectStore(t).delete(id));
  const replaceLocal=(t,rows)=>transaction(t,'readwrite',tx=>{const s=tx.objectStore(t);s.clear();for(const row of rows||[])if(row&&row.id!=null)s.put(row)});

  function arg(v){
    if(v===null||v===undefined)return {type:'null'};
    if(typeof v==='number')return {type:Number.isInteger(v)?'integer':'float',value:String(v)};
    if(typeof v==='boolean')return {type:'integer',value:v?'1':'0'};
    return {type:'text',value:String(v)};
  }
  function decodeValue(v){
    if(!v||v.type==='null')return null;
    if(v.type==='integer'||v.type==='float')return Number(v.value);
    return v.value??v.base64??null;
  }

  async function pipeline(statements,{write=false,direct=false,timeout=7000}={}){
    if(!Array.isArray(statements)||!statements.length)return [];
    const token=write?(directToken()||writeToken()):readToken();
    if(!cfg.url)throw new Error('رابط قاعدة Turso غير موجود في إعدادات المتجر');
    if(!token)throw new Error(write?'مفتاح الكتابة إلى Turso غير موجود':'مفتاح قراءة Turso غير موجود');
    const requests=statements.map(s=>({type:'execute',stmt:{sql:s.sql,...(s.args?{args:s.args.map(arg)}:{})}}));
    requests.push({type:'close'});
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeout);
    let res;
    try{
      res=await fetch(endpoint(),{
        method:'POST',
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({requests}),
        signal:controller.signal,
        cache:'no-store'
      });
    }catch(e){
      if(e?.name==='AbortError')throw new Error('الاتصال بقاعدة Turso بطيء. تحقق من الإنترنت وحاول مرة أخرى');
      throw new Error('تعذر الاتصال بقاعدة Turso. تحقق من الإنترنت');
    }finally{clearTimeout(timer)}
    if(!res.ok){
      let text='';try{text=(await res.text()).trim()}catch{}
      throw new Error('رفضت قاعدة Turso الطلب ('+res.status+')'+(text?' — '+text.slice(0,140):''));
    }
    let body;try{body=await res.json()}catch{throw new Error('وصل رد غير صالح من قاعدة Turso')}
    const output=[];
    for(let i=0;i<statements.length;i++){
      const r=body.results?.[i];
      if(!r)throw new Error('استجابة Turso غير مكتملة');
      if(r.type==='error')throw new Error(r.error?.message||'حدث خطأ داخل قاعدة Turso');
      const result=r.response?.result||{cols:[],rows:[]};
      const cols=(result.cols||[]).map(c=>c.name);
      output.push({
        rows:(result.rows||[]).map(row=>Object.fromEntries(row.map((v,j)=>[cols[j],decodeValue(v)]))),
        affected:Number(result.affected_row_count||0)
      });
    }
    cloudError='';
    return output;
  }

  async function ensureCloudSchema(){
    if(!directToken())return false;
    await pipeline([
      {sql:'CREATE TABLE IF NOT EXISTS oscar_store_records (collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (collection,id))'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_oscar_store_records_collection ON oscar_store_records(collection,updated_at)'}
    ],{write:true,direct:true,timeout:7000});
    return true;
  }
  async function schemaReady(){
    if(!schemaPromise)schemaPromise=ensureCloudSchema().catch(e=>{schemaPromise=null;cloudError=e.message;throw e});
    return schemaPromise;
  }
  async function cloudAll(t){
    if(directToken())await schemaReady();
    const [r]=await pipeline([{sql:'SELECT payload FROM oscar_store_records WHERE collection=? ORDER BY updated_at DESC',args:[t]}]);
    return r.rows.map(x=>{try{return JSON.parse(x.payload)}catch{return null}}).filter(Boolean);
  }
  async function cloudGet(t,id){
    if(directToken())await schemaReady();
    const [r]=await pipeline([{sql:'SELECT payload FROM oscar_store_records WHERE collection=? AND id=? LIMIT 1',args:[t,id]}]);
    if(!r.rows[0])return undefined;
    try{return JSON.parse(r.rows[0].payload)}catch{return undefined}
  }
  async function cloudPut(t,row){
    await schemaReady();
    await pipeline([{sql:'INSERT INTO oscar_store_records(collection,id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',args:[t,row.id,JSON.stringify(row),new Date().toISOString()]}],{write:true,direct:true});
  }
  async function cloudDel(t,id){
    await schemaReady();
    await pipeline([{sql:'DELETE FROM oscar_store_records WHERE collection=? AND id=?',args:[t,id]}],{write:true,direct:true});
  }
  async function cloudClear(t){
    await schemaReady();
    await pipeline([{sql:'DELETE FROM oscar_store_records WHERE collection=?',args:[t]}],{write:true,direct:true});
  }

  async function loadRemote(names=[...sharedTables]){
    const list=[...new Set(names.filter(t=>sharedTables.has(t)))];
    const data={};
    if(!list.length)return data;
    try{
      if(directToken())await schemaReady();
      const results=await pipeline(list.map(t=>({sql:'SELECT payload FROM oscar_store_records WHERE collection=? ORDER BY updated_at DESC',args:[t]})),{timeout:7000});
      for(let i=0;i<list.length;i++){
        const t=list[i];
        const rows=(results[i]?.rows||[]).map(x=>{try{return JSON.parse(x.payload)}catch{return null}}).filter(Boolean);
        data[t]=rows;
        await replaceLocal(t,rows);
      }
      cloudError='';
      return data;
    }catch(e){
      cloudError=e.message;
      console.warn('Turso direct load:',e);
      for(const t of list)data[t]=await localAll(t);
      return data;
    }
  }

  async function open(){
    await openLocal();
    if(directToken())schemaReady().catch(e=>console.warn('Turso schema:',e));
    return db;
  }
  async function all(t){
    if(!sharedTables.has(t))return localAll(t);
    try{
      const rows=await cloudAll(t);
      await replaceLocal(t,rows);
      return rows;
    }catch(e){
      cloudError=e.message;
      console.warn('Turso read:',e);
      return localAll(t);
    }
  }
  async function get(t,id){
    if(!sharedTables.has(t))return localGet(t,id);
    try{
      const row=await cloudGet(t,id);
      if(row)await localPut(t,row);else await localDel(t,id);
      return row;
    }catch(e){
      cloudError=e.message;
      console.warn('Turso get:',e);
      return localGet(t,id);
    }
  }
  async function put(t,row){
    if(!row||row.id==null)throw new Error('السجل غير صالح للحفظ');
    if(sharedTables.has(t)){
      if(canWriteCloud()){
        await cloudPut(t,row);
        await localPut(t,row);
        return row;
      }
      // المتجر العام لا ينشر تعديلات على بيانات الكتالوج؛ نحفظ التغيير المحلي فقط عند الحاجة.
      await localPut(t,row);
      return row;
    }
    await localPut(t,row);
    return row;
  }
  async function del(t,id){
    if(sharedTables.has(t)&&canWriteCloud())await cloudDel(t,id);
    await localDel(t,id);
  }

  async function snapshot(){
    const data={};
    for(const t of tables)data[t]=await all(t);
    return {format:'oscar-market',version:1,exportedAt:new Date().toISOString(),data};
  }
  async function restore(payload){
    if(payload.format!=='oscar-market'||payload.version!==1||!payload.data)throw new Error('صيغة النسخة الاحتياطية غير مدعومة');
    for(const t of tables){if(!Array.isArray(payload.data[t]))throw new Error('النسخة الاحتياطية غير مكتملة: '+t)}
    if(canWriteCloud()){
      for(const t of sharedTables){
        await cloudClear(t);
        for(const row of payload.data[t])await cloudPut(t,row);
      }
    }
    await transaction(tables,'readwrite',tx=>{for(const t of tables){const s=tx.objectStore(t);s.clear();for(const row of payload.data[t])s.put(row)}});
  }
  async function resetPublished(defaultSettings){
    if(!canWriteCloud())throw new Error('افتح admin.html لتعديل بيانات Turso');
    for(const t of sharedTables){await cloudClear(t);await replaceLocal(t,[])}
    if(defaultSettings)await put('settings',defaultSettings);
  }
  async function testConnection(){
    try{
      if(directToken())await schemaReady();
      await pipeline([{sql:'SELECT 1 AS ok'}],{timeout:5000});
      cloudError='';return {ok:true};
    }catch(e){cloudError=e.message;return {ok:false,error:e.message}}
  }
  const uuid=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);
  async function audit(action,details){await localPut('audit',{id:uuid(),action,details,date:new Date().toISOString()})}

  return {
    open,all,get,put,del,cachedAll:localAll,cachedGet:localGet,loadRemote,transaction,snapshot,restore,audit,uuid,
    tables,cloudTables:[...sharedTables],canWriteCloud,resetPublished,testConnection,
    sql:(statements,options={})=>pipeline(statements,{...options,direct:options.direct!==false}),
    ensureCloudSchema:schemaReady,
    get cloudError(){return cloudError}
  };
})();

window.Auth={
 async digest(password,salt){if(!crypto.subtle)throw new Error('شغّل التطبيق من HTTPS أو localhost لتأمين كلمات المرور');const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:150000,hash:'SHA-256'},key,256);return Array.from(new Uint8Array(bits)).map(v=>v.toString(16).padStart(2,'0')).join('');},
 async credentials(password){if(password.length<8)throw new Error('كلمة المرور يجب أن تكون 8 أحرف على الأقل');const salt=DB.uuid();return {salt,hash:await this.digest(password,salt)}},
 async register(data,role='customer'){const users=await DB.all('users');if(users.some(u=>u.username.toLowerCase()===data.username.trim().toLowerCase()))throw new Error('اسم المستخدم مستخدم بالفعل');if(role==='admin'&&users.some(u=>u.role==='admin'))throw new Error('تم إعداد حساب الإدارة بالفعل');const user={...data,username:data.username.trim(),...await this.credentials(data.password),id:DB.uuid(),role,date:new Date().toISOString()};delete user.password;delete user.confirm;await DB.put('users',user);return user;},
 async login(username,password,role){const user=(await DB.all('users')).find(u=>u.username.toLowerCase()===username.trim().toLowerCase()&&(!role||u.role===role));if(!user||await this.digest(password,user.salt)!==user.hash)throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة');localStorage.setItem(role==='admin'?'oscar-admin':'oscar-user',user.id);return user;},
 async current(admin=false){return DB.get('users',localStorage.getItem(admin?'oscar-admin':'oscar-user')||'')},
 logout(admin=false){localStorage.removeItem(admin?'oscar-admin':'oscar-user')}
};
window.Pricing={
 active(row,now=new Date()){const day=now.toISOString().slice(0,10);return row.active!==false&&(!row.start||row.start<=day)&&(!row.end||row.end>=day)},
 discount(amount,type,value){return Math.min(amount,Math.max(0,type==='percent'?amount*Number(value||0)/100:Number(value||0)))},
 product(p,offers=[],now=new Date()){let discount=0;if(this.active(p,now))discount=this.discount(p.price,p.discountType,p.discountValue);for(const o of offers){if(this.active(o,now)&&(o.scope==='all'||o.scope==='category'&&o.target===p.category||o.scope==='products'&&(o.target||'').split(',').map(x=>x.trim()).includes(p.id)))discount=Math.max(discount,this.discount(p.price,o.discountType,o.discountValue))}return Math.round(Math.max(0,p.price-discount)*100)/100},
 totals(products,offers,coupon){const original=products.reduce((s,p)=>s+Number(p.price),0);const subtotal=products.reduce((s,p)=>s+this.product(p,offers),0);const discount=coupon?this.discount(subtotal,coupon.discountType,coupon.discountValue):0;return {original:round(original),subtotal:round(subtotal),productDiscount:round(original-subtotal),couponDiscount:round(discount),total:round(subtotal-discount)}}
};
function round(v){return Math.round(v*100)/100}
