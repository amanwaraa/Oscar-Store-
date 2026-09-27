'use strict';
/* Oscar P2P v4 - Turso-direct localhost + hosted API production. */
try{window.Telegram?.WebApp?.ready();window.Telegram?.WebApp?.expand()}catch{}
window.P2P_STATUS={pending_payment:'بانتظار الدفع',payment_review:'قيد مراجعة الدفع',payment_approved:'تم قبول الدفع',payment_rejected:'تم رفض الدفع',processing:'قيد التنفيذ',completed:'مكتمل',cancelled:'ملغي'};
function p2pStatusLabel(v){return P2P_STATUS[v]||v||'—'}
function telegramWebApp(){return window.Telegram?.WebApp||null}
function telegramProfile(){const tg=telegramWebApp(),u=tg?.initDataUnsafe?.user;if(!u?.id)return null;return {telegram_id:String(u.id),telegram_username:u.username||'',first_name:u.first_name||'',last_name:u.last_name||'',full_name:[u.first_name,u.last_name].filter(Boolean).join(' ')||u.username||String(u.id),photo_url:u.photo_url||'',language_code:u.language_code||''}}
function p2pOwnerKey(){let k=localStorage.getItem('oscar-p2p-owner-key');if(!k||k.length<32){const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);k=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');localStorage.setItem('oscar-p2p-owner-key',k)}return k}
function p2pCheckoutKey(ids,coupon=''){const sig=[...ids].map(String).sort().join('|')+'#'+String(coupon||'');try{const saved=JSON.parse(sessionStorage.getItem('oscar-p2p-checkout')||'null');if(saved&&saved.sig===sig&&Date.now()-saved.at<10*60*1000)return saved.key}catch{}const key='CK-'+(crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2));sessionStorage.setItem('oscar-p2p-checkout',JSON.stringify({sig,key,at:Date.now()}));return key}
function clearP2PCheckoutKey(){sessionStorage.removeItem('oscar-p2p-checkout')}


/*
 * Local preview bridge
 * --------------------
 * Static preview servers such as localhost:xxxx cannot execute /api routes.
 * In that case P2P falls back to a browser-local implementation so the full
 * checkout/review flow can still be tested from the same origin. Production
 * continues to prefer the real server API whenever it is available.
 */
const LocalP2P=(()=>{
 const K={methods:'oscar-p2p-local-methods-v1',orders:'oscar-p2p-local-orders-v1',notifications:'oscar-p2p-local-notifications-v1'};
 const supported=()=>location.protocol==='file:'||/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(location.hostname)||String(location.hostname||'').endsWith('.localhost');
 const read=(key,def=[])=>{try{const v=JSON.parse(localStorage.getItem(key)||'null');return Array.isArray(v)?v:def}catch{return def}};
 const write=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));return value}catch(e){if(e?.name==='QuotaExceededError')throw new Error('مساحة التخزين المحلي امتلأت. احذف إثباتات قديمة أو استخدم صورة أصغر.');throw e}};
 const clone=v=>JSON.parse(JSON.stringify(v));
 const now=()=>new Date().toISOString();
 const uid=(prefix='L')=>prefix+'-'+(crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2));
 const orderNo=()=>{const d=new Date(),date=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('');return 'ST-'+date+'-'+String(Date.now()).slice(-6)};
 const owner=()=>p2pOwnerKey();
 const tg=()=>telegramProfile();
 const methods=()=>read(K.methods,[]);
 const orders=()=>read(K.orders,[]);
 const notifications=()=>read(K.notifications,[]);
 const saveMethods=rows=>write(K.methods,rows);
 const saveOrders=rows=>write(K.orders,rows);
 const saveNotifications=rows=>write(K.notifications,rows.slice(0,200));
 const findOrder=(id,admin=false)=>{const o=orders().find(x=>x.id===id);if(!o)throw new Error('الطلب غير موجود');if(!admin){const t=tg();const mine=o.owner_key===owner()||(t?.telegram_id&&String(o.telegram?.telegram_id||'')===String(t.telegram_id));if(!mine)throw new Error('لا تملك صلاحية فتح هذا الطلب')}return o};
 const putOrder=o=>{const rows=orders(),i=rows.findIndex(x=>x.id===o.id);if(i>=0)rows[i]=o;else rows.unshift(o);saveOrders(rows);return clone(o)};
 const notify=(o,title,body)=>{const rows=notifications();rows.unshift({id:uid('NT'),owner_key:o.owner_key,telegram_id:o.telegram?.telegram_id||'',title,body,created_at:now(),read_at:''});saveNotifications(rows)};
 async function createOrder(body){
   const ids=[...new Set((body.product_ids||[]).map(String).filter(Boolean))];
   if(!ids.length)throw new Error('السلة فارغة');
   const checkout=String(body.checkout_key||'');
   const existing=checkout?orders().find(x=>x.owner_key===owner()&&x.checkout_key===checkout&&Date.now()-Date.parse(x.created_at||0)<10*60*1000):null;
   if(existing)return clone(existing);
   let products=[];try{products=(window.S?.products||[]).filter(p=>ids.includes(String(p.id))&&p.status==='active')}catch{}
   if(products.length!==ids.length){const cloud=await DB.all('products');products=cloud.filter(p=>ids.includes(String(p.id))&&p.status==='active')}
   if(products.length!==ids.length)throw new Error('أحد التطبيقات غير متاح أو غير منشور حالياً');
   let offers=[];try{offers=window.S?.offers||[]}catch{offers=await DB.all('offers')}
   let coupons=[];try{coupons=window.S?.coupons||[]}catch{coupons=await DB.all('coupons')}
   let coupon=null;const code=String(body.coupon_code||'').trim();if(code){coupon=coupons.find(c=>String(c.code||'').toLowerCase()===code.toLowerCase());if(!coupon||!Pricing.active(coupon))throw new Error('كود الخصم غير صالح أو منتهي')}
   const total=Pricing.totals(products,offers,coupon);
   const items=products.map(p=>{const unit=Pricing.product(p,offers);return {id:uid('IT'),product_id:p.id,product_name:p.name,unit_price:unit,quantity:1,subtotal:unit}});
   // Apply coupon to the invoice total while preserving each product's captured price.
   const order={id:orderNo(),owner_key:owner(),checkout_key:checkout,telegram:tg()||null,customer:body.local_user||localUserProfile(),items,original:total.original,product_discount:total.productDiscount,coupon_discount:total.couponDiscount,total:total.total,currency:window.S?.settings?.currency||'₪',status:'pending_payment',payment_method_id:'',payment_method_name:'',payment_proof:null,rejection_reason:'',created_at:now(),updated_at:now(),local_preview:true};
   return putOrder(order)
 }
 async function route(path,opt={}){
   const method=String(opt.method||'GET').toUpperCase();let body={};if(opt.body){try{body=JSON.parse(opt.body)}catch{throw new Error('بيانات الطلب غير صحيحة')}}
   const clean=('/'+String(path||'').replace(/^\/+/, '')).replace(/\/+$/,'')||'/';
   const seg=clean.split('/').filter(Boolean).map(decodeURIComponent);
   if(clean==='/health')return {ok:true,service:'Oscar P2P Local Preview',version:'local-1',configured:true,database:true,local_preview:true};
   if(clean==='/orders'&&method==='POST')return {order:await createOrder(body)};
   if(clean==='/orders'&&method==='GET')return {orders:orders().filter(o=>{const t=tg();return o.owner_key===owner()||(t?.telegram_id&&String(o.telegram?.telegram_id||'')===String(t.telegram_id))}).sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''))};
   if(seg[0]==='orders'&&seg[1]&&seg.length===2&&method==='GET')return {order:clone(findOrder(seg[1]))};
   if(seg[0]==='orders'&&seg[1]&&seg[2]==='proof'&&method==='POST'){
     const o=findOrder(seg[1]);if(!['pending_payment','payment_rejected'].includes(o.status))throw new Error('لا يمكن إرسال إثبات دفع لهذه الحالة');
     const m=methods().find(x=>x.id===body.payment_method_id&&x.status!=='disabled');if(!m)throw new Error('طريقة الدفع غير متاحة');
     if(!String(body.sender_account_name||'').trim())throw new Error('اكتب اسم الحساب الذي تم التحويل منه');if(!String(body.proof_image||'').startsWith('data:image/'))throw new Error('ارفع صورة إثبات الدفع');
     const submitted=now();o.payment_method_id=m.id;o.payment_method_name=m.name;o.payment_proof={id:uid('PF'),order_id:o.id,user_id:o.customer?.id||'',payment_method_id:m.id,sender_account_name:String(body.sender_account_name).trim(),proof_image:String(body.proof_image),status:'payment_review',rejection_reason:'',submitted_at:submitted,reviewed_at:'',reviewed_by:''};o.status='payment_review';o.rejection_reason='';o.updated_at=submitted;putOrder(o);notify(o,'تم استلام إثبات الدفع','طلبك '+o.id+' قيد مراجعة الدفع.');return {order:clone(o)}
   }
   if(clean==='/notifications'&&method==='GET')return {notifications:notifications().filter(n=>n.owner_key===owner()).sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''))};
   if(clean==='/payment-methods'&&method==='GET')return {payment_methods:methods().filter(m=>m.status!=='disabled').sort((a,b)=>(Number(a.sort_order)||0)-(Number(b.sort_order)||0)||(a.created_at||'').localeCompare(b.created_at||''))};
   if(seg[0]==='payment-methods'&&seg[1]&&method==='GET'){const m=methods().find(x=>x.id===seg[1]&&x.status!=='disabled');if(!m)throw new Error('طريقة الدفع غير متاحة');return {payment_method:clone(m)}}
   if(clean==='/admin/payment-methods'&&method==='GET')return {payment_methods:methods().sort((a,b)=>(Number(a.sort_order)||0)-(Number(b.sort_order)||0))};
   if(clean==='/admin/payment-methods'&&method==='POST'){const nowIso=now(),rows=methods(),row={...body,id:String(body.id||uid('PM')),name:String(body.name||'').trim(),image:String(body.image||''),description:String(body.description||''),payment_details:String(body.payment_details||'').trim(),instructions:String(body.instructions||''),status:body.status==='disabled'?'disabled':'active',sort_order:Math.max(0,Number(body.sort_order)||0),created_at:body.created_at||nowIso,updated_at:nowIso};if(!row.name)throw new Error('اسم طريقة الدفع مطلوب');if(!row.payment_details)throw new Error('بيانات الدفع مطلوبة');const i=rows.findIndex(x=>x.id===row.id);if(i>=0)rows[i]=row;else rows.push(row);saveMethods(rows);return {payment_method:clone(row)}}
   if(seg[0]==='admin'&&seg[1]==='payment-methods'&&seg[2]&&method==='DELETE'){saveMethods(methods().filter(x=>x.id!==seg[2]));return {ok:true}}
   if(clean==='/admin/orders'&&method==='GET')return {orders:orders().sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''))};
   if(seg[0]==='admin'&&seg[1]==='orders'&&seg[2]&&seg.length===3&&method==='GET')return {order:clone(findOrder(seg[2],true))};
   if(seg[0]==='admin'&&seg[1]==='orders'&&seg[2]&&seg[3]==='approve'&&method==='POST'){const o=findOrder(seg[2],true);if(o.status!=='payment_review')throw new Error('الطلب ليس قيد مراجعة الدفع');const t=now();o.status='payment_approved';o.updated_at=t;o.approved_at=t;o.approved_by='local-admin';if(o.payment_proof){o.payment_proof.status='payment_approved';o.payment_proof.reviewed_at=t;o.payment_proof.reviewed_by='local-admin';o.payment_proof.rejection_reason=''}putOrder(o);notify(o,'تم قبول الدفع','تم قبول الدفع للطلب '+o.id+'.');return {order:clone(o)}}
   if(seg[0]==='admin'&&seg[1]==='orders'&&seg[2]&&seg[3]==='reject'&&method==='POST'){const reason=String(body.reason||'').trim();if(!reason)throw new Error('سبب الرفض مطلوب');const o=findOrder(seg[2],true);const t=now();o.status='payment_rejected';o.rejection_reason=reason;o.updated_at=t;o.rejected_at=t;o.rejected_by='local-admin';if(o.payment_proof){o.payment_proof.status='payment_rejected';o.payment_proof.rejection_reason=reason;o.payment_proof.reviewed_at=t;o.payment_proof.reviewed_by='local-admin'}putOrder(o);notify(o,'تم رفض إثبات الدفع','الطلب '+o.id+': '+reason);return {order:clone(o)}}
   if(seg[0]==='admin'&&seg[1]==='orders'&&seg[2]&&seg[3]==='status'&&method==='POST'){const allowed=['processing','completed','cancelled'],status=String(body.status||'');if(!allowed.includes(status))throw new Error('حالة الطلب غير صحيحة');const o=findOrder(seg[2],true);o.status=status;o.updated_at=now();putOrder(o);notify(o,'تحديث حالة الطلب','حالة الطلب '+o.id+' الآن: '+p2pStatusLabel(status));return {order:clone(o)}}
   throw new Error('المسار المحلي غير مدعوم: '+clean)
 }
 return {supported,route};
})();


/* Turso المباشر على localhost: بدون Worker وبدون dynamic import. */
const DirectTursoP2P=(()=>{
 let readyPromise=null;
 const localHost=()=>location.protocol==='file:'||/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(location.hostname)||String(location.hostname||'').endsWith('.localhost');
 const cfg=()=>window.OSCAR_TURSO_CONFIG||{};
 const token=()=>String(cfg().directToken||cfg().adminToken||'').trim();
 const supported=()=>localHost()&&!!String(cfg().url||'').trim()&&!!token()&&!!window.DB?.sql;
 const uid=(prefix='ID')=>prefix+'-'+(crypto.randomUUID?crypto.randomUUID():DB.uuid());
 const now=()=>new Date().toISOString();
 const parse=v=>{try{return JSON.parse(v)}catch{return null}};
 const bodyOf=opt=>{if(!opt?.body)return {};if(typeof opt.body==='object')return opt.body;try{return JSON.parse(opt.body)}catch{throw new Error('بيانات الطلب غير صحيحة')}};
 async function sql(statements){return DB.sql(statements,{write:true,direct:true,timeout:9000})}
 async function ensure(){
   if(readyPromise)return readyPromise;
   readyPromise=sql([
    {sql:'CREATE TABLE IF NOT EXISTS p2p_orders (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, telegram_id TEXT, payload TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL, currency TEXT NOT NULL, payment_method_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_p2p_orders_owner ON p2p_orders(owner_key,created_at)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_p2p_orders_telegram ON p2p_orders(telegram_id,created_at)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_p2p_orders_status ON p2p_orders(status,created_at)'},
    {sql:'CREATE TABLE IF NOT EXISTS order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL, unit_price REAL NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, subtotal REAL NOT NULL)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)'},
    {sql:"CREATE TABLE IF NOT EXISTS payment_methods (id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT, description TEXT, payment_details TEXT NOT NULL, instructions TEXT, status TEXT NOT NULL DEFAULT 'active', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"},
    {sql:'CREATE INDEX IF NOT EXISTS idx_payment_methods_status_sort ON payment_methods(status,sort_order,created_at)'},
    {sql:'CREATE TABLE IF NOT EXISTS payment_proofs (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, user_id TEXT, payment_method_id TEXT NOT NULL, sender_account_name TEXT NOT NULL, proof_image TEXT NOT NULL, status TEXT NOT NULL, rejection_reason TEXT, submitted_at TEXT NOT NULL, reviewed_at TEXT, reviewed_by TEXT)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_payment_proofs_order ON payment_proofs(order_id)'},
    {sql:'CREATE TABLE IF NOT EXISTS p2p_notifications (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, telegram_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT)'},
    {sql:'CREATE INDEX IF NOT EXISTS idx_p2p_notifications_owner ON p2p_notifications(owner_key,created_at)'},
    {sql:'CREATE TABLE IF NOT EXISTS p2p_checkout_keys (checkout_key TEXT PRIMARY KEY, owner_key TEXT NOT NULL, order_id TEXT NOT NULL, created_at TEXT NOT NULL)'}
   ]).then(()=>true).catch(e=>{readyPromise=null;throw e});
   return readyPromise;
 }
 async function records(collection){const [r]=await sql([{sql:'SELECT payload FROM oscar_store_records WHERE collection=? ORDER BY updated_at DESC',args:[collection]}]);return r.rows.map(x=>parse(x.payload)).filter(Boolean)}
 async function record(collection,id){const [r]=await sql([{sql:'SELECT payload FROM oscar_store_records WHERE collection=? AND id=? LIMIT 1',args:[collection,id]}]);return r.rows[0]?parse(r.rows[0].payload):null}
 async function putRecord(collection,row){await sql([{sql:'INSERT INTO oscar_store_records(collection,id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',args:[collection,row.id,JSON.stringify(row),now()]}])}
 function active(row){const d=new Date().toISOString().slice(0,10);return !!row&&row.active!==false&&(!row.start||row.start<=d)&&(!row.end||row.end>=d)}
 function disc(amount,type,value){return Math.min(Number(amount)||0,Math.max(0,type==='percent'?(Number(amount)||0)*(Number(value)||0)/100:Number(value)||0))}
 function r2(v){return Math.round((Number(v)||0)*100)/100}
 function productPrice(p,offers){let d=0;if(active(p))d=disc(p.price,p.discountType,p.discountValue);for(const o of offers||[]){const hit=active(o)&&(o.scope==='all'||o.scope==='category'&&o.target===p.category||o.scope==='products'&&String(o.target||'').split(',').map(x=>x.trim()).includes(p.id));if(hit)d=Math.max(d,disc(p.price,o.discountType,o.discountValue))}return r2(Math.max(0,Number(p.price||0)-d))}
 function actor(body={}){const tg=telegramProfile();return {owner_key:p2pOwnerKey(),telegram:tg||null,telegram_id:tg?.telegram_id||'',local_user:body.local_user||{}}}
 function orderId(){const d=new Date(),date=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('');return `ST-${date}-${(crypto.randomUUID?crypto.randomUUID():DB.uuid()).replace(/-/g,'').slice(0,6).toUpperCase()}`}
 async function listMethods(activeOnly=true){const [r]=await sql([{sql:activeOnly?"SELECT id,name,image,description,payment_details,instructions,status,sort_order,created_at,updated_at FROM payment_methods WHERE status='active' ORDER BY sort_order ASC,created_at ASC":'SELECT id,name,image,description,payment_details,instructions,status,sort_order,created_at,updated_at FROM payment_methods ORDER BY sort_order ASC,created_at ASC'}]);return r.rows}
 async function getMethod(id,activeOnly=true){const [r]=await sql([{sql:activeOnly?"SELECT id,name,image,description,payment_details,instructions,status,sort_order,created_at,updated_at FROM payment_methods WHERE id=? AND status='active' LIMIT 1":'SELECT id,name,image,description,payment_details,instructions,status,sort_order,created_at,updated_at FROM payment_methods WHERE id=? LIMIT 1',args:[id]}]);if(!r.rows[0])throw new Error('طريقة الدفع غير موجودة أو غير مفعلة');return r.rows[0]}
 async function getProof(orderId,includeImage=true){const [r]=await sql([{sql:'SELECT * FROM payment_proofs WHERE order_id=? LIMIT 1',args:[orderId]}]);if(!r.rows[0])return null;const p={...r.rows[0]};if(!includeImage)delete p.proof_image;return p}
 async function hydrate(order,includeImage=true){if(!order)return null;const p=await getProof(order.id,includeImage);if(p){order.payment_proof=p;order.rejection_reason=p.rejection_reason||order.rejection_reason||''}return order}
 async function notify(order,title,body){await sql([{sql:'INSERT INTO p2p_notifications(id,owner_key,telegram_id,title,body,created_at,read_at) SELECT ?,owner_key,telegram_id,?,?,?,NULL FROM p2p_orders WHERE id=?',args:[uid('NT'),title,body,now(),order.id]}])}
 async function createOrder(body){
   const a=actor(body),checkoutKey=String(body.checkout_key||'').slice(0,120),ids=[...new Set((body.product_ids||[]).map(String).filter(Boolean))];
   if(!ids.length)throw new Error('السلة فارغة');
   if(checkoutKey){const [ck]=await sql([{sql:'SELECT order_id FROM p2p_checkout_keys WHERE checkout_key=? AND owner_key=? LIMIT 1',args:[checkoutKey,a.owner_key]}]);if(ck.rows[0]){const [old]=await sql([{sql:'SELECT payload FROM p2p_orders WHERE id=? LIMIT 1',args:[ck.rows[0].order_id]}]);if(old.rows[0])return parse(old.rows[0].payload)}}
   const [products,offers,coupons,settingsRows]=await Promise.all([records('products'),records('offers'),records('coupons'),records('settings')]);
   const selected=ids.map(id=>products.find(p=>String(p.id)===id&&p.status==='active'));if(selected.some(x=>!x))throw new Error('أحد التطبيقات في السلة غير منشور حالياً. حدّث السلة وحاول مجدداً');
   const subtotal=r2(selected.reduce((s,p)=>s+productPrice(p,offers),0));let coupon=null;const code=String(body.coupon_code||'').trim().toUpperCase();if(code){coupon=coupons.find(c=>String(c.code||'').toUpperCase()===code);if(!coupon||!active(coupon))throw new Error('كوبون الخصم غير صالح أو منتهي');if(Number(coupon.min||0)>subtotal)throw new Error('الطلب لا يصل للحد الأدنى للكوبون');if(Number(coupon.maxUses||0)>0&&Number(coupon.used||0)>=Number(coupon.maxUses))throw new Error('تم استهلاك الحد الأقصى للكوبون')}
   const items=selected.map(p=>{const unit=productPrice(p,offers);return {product_id:String(p.id),product_name:String(p.name||'تطبيق'),sku:p.sku||'',unit_price:unit,quantity:1,subtotal:unit}});
   const original=r2(selected.reduce((s,p)=>s+Number(p.price||0),0)),productDiscount=r2(original-subtotal),couponDiscount=r2(coupon?disc(subtotal,coupon.discountType,coupon.discountValue):0),total=r2(subtotal-couponDiscount),settings=settingsRows.find(x=>x.id==='store')||{},currency=settings.currency||'₪',created=now(),id=orderId();
   const customer=a.telegram?{name:a.telegram.full_name,username:a.telegram.telegram_username||'',auth_provider:'telegram'}:{name:String(a.local_user?.name||'عميل'),username:String(a.local_user?.username||''),phone:String(a.local_user?.phone||''),email:String(a.local_user?.email||''),auth_provider:a.local_user?.auth_provider||'local'};
   const order={id,customer,telegram:a.telegram,items,original,subtotal,product_discount:productDiscount,coupon_discount:couponDiscount,total,currency,coupon:coupon?.code||'',status:'pending_payment',payment_method_id:'',payment_method_name:'',rejection_reason:'',created_at:created,updated_at:created};
   const st=[{sql:'INSERT INTO p2p_orders(id,owner_key,telegram_id,payload,status,total,currency,payment_method_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',args:[id,a.owner_key,a.telegram_id,JSON.stringify(order),order.status,total,currency,'',created,created]}];items.forEach((it,i)=>st.push({sql:'INSERT INTO order_items(id,order_id,product_id,product_name,unit_price,quantity,subtotal) VALUES(?,?,?,?,?,?,?)',args:[id+'-'+(i+1),id,it.product_id,it.product_name,it.unit_price,it.quantity,it.subtotal]}));if(checkoutKey)st.push({sql:'INSERT OR IGNORE INTO p2p_checkout_keys(checkout_key,owner_key,order_id,created_at) VALUES(?,?,?,?)',args:[checkoutKey,a.owner_key,id,created]});await sql(st);if(coupon){coupon.used=(Number(coupon.used)||0)+1;await putRecord('coupons',coupon)}return order;
 }
 async function myOrders(){const a=actor(),q=a.telegram_id?{sql:'SELECT payload FROM p2p_orders WHERE owner_key=? OR telegram_id=? ORDER BY created_at DESC LIMIT 200',args:[a.owner_key,a.telegram_id]}:{sql:'SELECT payload FROM p2p_orders WHERE owner_key=? ORDER BY created_at DESC LIMIT 200',args:[a.owner_key]};const [r]=await sql([q]);return r.rows.map(x=>parse(x.payload)).filter(Boolean)}
 async function myOrder(id,withProof=true){const a=actor(),q=a.telegram_id?{sql:'SELECT payload FROM p2p_orders WHERE id=? AND (owner_key=? OR telegram_id=?) LIMIT 1',args:[id,a.owner_key,a.telegram_id]}:{sql:'SELECT payload FROM p2p_orders WHERE id=? AND owner_key=? LIMIT 1',args:[id,a.owner_key]};const [r]=await sql([q]);if(!r.rows[0])throw new Error('الطلب غير موجود');return hydrate(parse(r.rows[0].payload),withProof)}
 async function adminOrder(id,withProof=true){const [r]=await sql([{sql:'SELECT payload FROM p2p_orders WHERE id=? LIMIT 1',args:[id]}]);if(!r.rows[0])throw new Error('الطلب غير موجود');return hydrate(parse(r.rows[0].payload),withProof)}
 async function route(path,opt={}){
   if(!supported())throw new Error('اتصال Turso المحلي غير مهيأ');await ensure();const method=String(opt.method||'GET').toUpperCase(),body=bodyOf(opt),clean=('/'+String(path||'').replace(/^\/+/, '')).replace(/\/+$/,'')||'/',seg=clean.split('/').filter(Boolean).map(decodeURIComponent);
   if(clean==='/health')return {ok:true,configured:true,database:true,direct_turso:true,version:'direct-2'};
   if(clean==='/payment-methods'&&method==='GET')return {payment_methods:await listMethods(true)};
   if(seg[0]==='payment-methods'&&seg[1]&&method==='GET')return {payment_method:await getMethod(seg[1],true)};
   if(clean==='/admin/payment-methods'&&method==='GET')return {payment_methods:await listMethods(false)};
   if(clean==='/admin/payment-methods'&&method==='POST'){const name=String(body.name||'').trim(),details=String(body.payment_details||'').trim();if(!name)throw new Error('اسم طريقة الدفع مطلوب');if(!details)throw new Error('بيانات الدفع مطلوبة');const id=String(body.id||uid('PM')),n=now(),[cur]=await sql([{sql:'SELECT created_at FROM payment_methods WHERE id=? LIMIT 1',args:[id]}]),created=cur.rows[0]?.created_at||n,status=body.status==='disabled'?'disabled':'active',sort=Math.max(0,Number(body.sort_order)||0);await sql([{sql:'INSERT INTO payment_methods(id,name,image,description,payment_details,instructions,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,image=excluded.image,description=excluded.description,payment_details=excluded.payment_details,instructions=excluded.instructions,status=excluded.status,sort_order=excluded.sort_order,updated_at=excluded.updated_at',args:[id,name,String(body.image||''),String(body.description||''),details,String(body.instructions||''),status,sort,created,n]}]);return {payment_method:await getMethod(id,false)}}
   if(seg[0]==='admin'&&seg[1]==='payment-methods'&&seg[2]&&method==='DELETE'){await sql([{sql:'DELETE FROM payment_methods WHERE id=?',args:[seg[2]]}]);return {ok:true}}
   if(clean==='/orders'&&method==='POST')return {order:await createOrder(body)};
   if(clean==='/orders'&&method==='GET')return {orders:await myOrders()};
   if(seg[0]==='orders'&&seg[1]&&seg.length===2&&method==='GET')return {order:await myOrder(seg[1],true)};
   if(seg[0]==='orders'&&seg[1]&&seg[2]==='proof'&&method==='POST'){const order=await myOrder(seg[1],false);if(!['pending_payment','payment_rejected'].includes(order.status))throw new Error('لا يمكن رفع إثبات لهذا الطلب في حالته الحالية');const m=await getMethod(String(body.payment_method_id||''),true),sender=String(body.sender_account_name||'').trim(),img=String(body.proof_image||'');if(!sender)throw new Error('اسم الحساب المحول منه مطلوب');if(!/^data:image\/(?:webp|jpeg|png);base64,/i.test(img))throw new Error('صورة إثبات الدفع مطلوبة');if(img.length>3200000)throw new Error('صورة إثبات الدفع كبيرة جداً');const n=now(),proofId=uid('PF'),a=actor(body);order.status='payment_review';order.payment_method_id=m.id;order.payment_method_name=m.name;order.rejection_reason='';order.updated_at=n;await sql([{sql:"INSERT INTO payment_proofs(id,order_id,user_id,payment_method_id,sender_account_name,proof_image,status,rejection_reason,submitted_at,reviewed_at,reviewed_by) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(order_id) DO UPDATE SET payment_method_id=excluded.payment_method_id,sender_account_name=excluded.sender_account_name,proof_image=excluded.proof_image,status='payment_review',rejection_reason=NULL,submitted_at=excluded.submitted_at,reviewed_at=NULL,reviewed_by=NULL",args:[proofId,order.id,a.telegram_id||a.owner_key,m.id,sender,img,'payment_review',null,n]},{sql:'UPDATE p2p_orders SET payload=?,status=?,payment_method_id=?,updated_at=? WHERE id=?',args:[JSON.stringify(order),'payment_review',m.id,n,order.id]}]);await notify(order,'تم استلام إثبات الدفع','طلبك '+order.id+' قيد مراجعة الدفع.');return {order:await hydrate(order,true)}}
   if(clean==='/notifications'&&method==='GET'){const a=actor(),q=a.telegram_id?{sql:'SELECT id,title,body,created_at FROM p2p_notifications WHERE owner_key=? OR telegram_id=? ORDER BY created_at DESC LIMIT 100',args:[a.owner_key,a.telegram_id]}:{sql:'SELECT id,title,body,created_at FROM p2p_notifications WHERE owner_key=? ORDER BY created_at DESC LIMIT 100',args:[a.owner_key]};const [r]=await sql([q]);return {notifications:r.rows}}
   if(clean==='/admin/orders'&&method==='GET'){const [ordersR,proofR]=await sql([{sql:'SELECT payload FROM p2p_orders ORDER BY created_at DESC LIMIT 1000'},{sql:'SELECT id,order_id,user_id,payment_method_id,sender_account_name,status,rejection_reason,submitted_at,reviewed_at,reviewed_by FROM payment_proofs ORDER BY submitted_at DESC'}]);const proofs=new Map(proofR.rows.map(p=>[p.order_id,p])),orders=ordersR.rows.map(x=>parse(x.payload)).filter(Boolean).map(o=>{const p=proofs.get(o.id);if(p)o.payment_proof=p;return o});return {orders}}
   if(seg[0]==='admin'&&seg[1]==='orders'&&seg[2]&&seg.length===3&&method==='GET')return {order:await adminOrder(seg[2],true)};
   if(seg[0]==='admin'&&seg[1]==='orders'&&seg[2]&&seg[3]==='approve'&&method==='POST'){const order=await adminOrder(seg[2],false);if(order.status!=='payment_review')throw new Error('الطلب ليس قيد مراجعة الدفع');const n=now(),admin=window.Admin?.user?.name||'المدير';order.status='payment_approved';order.approved_by=admin;order.approved_at=n;order.rejection_reason='';order.updated_at=n;await sql([{sql:'UPDATE payment_proofs SET status=?,rejection_reason=NULL,reviewed_at=?,reviewed_by=? WHERE order_id=?',args:['payment_approved',n,admin,order.id]},{sql:'UPDATE p2p_orders SET payload=?,status=?,updated_at=? WHERE id=?',args:[JSON.stringify(order),'payment_approved',n,order.id]}]);await notify(order,'تم قبول الدفع','تم قبول الدفع للطلب رقم '+order.id);return {order:await hydrate(order,true)}}
   if(seg[0]==='admin'&&seg[1]==='orders'&&seg[2]&&seg[3]==='reject'&&method==='POST'){const order=await adminOrder(seg[2],false);if(order.status!=='payment_review')throw new Error('الطلب ليس قيد مراجعة الدفع');const reason=String(body.reason||'').trim();if(!reason)throw new Error('سبب الرفض مطلوب');const n=now(),admin=window.Admin?.user?.name||'المدير';order.status='payment_rejected';order.rejection_reason=reason;order.rejected_by=admin;order.rejected_at=n;order.updated_at=n;await sql([{sql:'UPDATE payment_proofs SET status=?,rejection_reason=?,reviewed_at=?,reviewed_by=? WHERE order_id=?',args:['payment_rejected',reason,n,admin,order.id]},{sql:'UPDATE p2p_orders SET payload=?,status=?,updated_at=? WHERE id=?',args:[JSON.stringify(order),'payment_rejected',n,order.id]}]);await notify(order,'تم رفض إثبات الدفع','الطلب '+order.id+': '+reason);return {order:await hydrate(order,true)}}
   if(seg[0]==='admin'&&seg[1]==='orders'&&seg[2]&&seg[3]==='status'&&method==='POST'){const status=String(body.status||'');if(!['processing','completed','cancelled'].includes(status))throw new Error('الحالة غير مسموحة');const order=await adminOrder(seg[2],false),old=order.status;if(status==='processing'&&old!=='payment_approved')throw new Error('يجب قبول الدفع أولاً');if(status==='completed'&&old!=='processing')throw new Error('حوّل الطلب إلى قيد التنفيذ أولاً');if(old==='completed')throw new Error('الطلب مكتمل بالفعل');const n=now();order.status=status;order.updated_at=n;await sql([{sql:'UPDATE p2p_orders SET payload=?,status=?,updated_at=? WHERE id=?',args:[JSON.stringify(order),status,n,order.id]}]);if(status==='completed')for(const item of order.items||[]){const p=await record('products',item.product_id);if(p){p.purchases=Math.max(0,Number(p.purchases||0)+1);await putRecord('products',p)}}await notify(order,'تحديث حالة الطلب','حالة الطلب '+order.id+' الآن: '+({processing:'قيد التنفيذ',completed:'مكتمل',cancelled:'ملغي'}[status]||status));return {order:await hydrate(order,true)}}
   throw new Error('المسار المطلوب غير موجود في نظام الدفع');
 }
 return {supported,route};
})();

window.P2PAPI={
 _endpoint:null,
 _health:null,
 endpointCandidates(){
   const out=[];
   const add=(base,prefix='')=>{base=String(base||'').trim().replace(/\/$/,'');if(!base)return;const key=base+'|'+prefix;if(!out.some(x=>x.key===key))out.push({key,base,prefix})};
   let custom='';try{custom=String(S?.settings?.p2pApiBase||window.OSCAR_P2P_API_BASE||'').trim()}catch{custom=String(window.OSCAR_P2P_API_BASE||'').trim()}
   if(custom){const clean=custom.replace(/\/$/,'');if(/\/(?:api|\.netlify\/functions\/p2p)$/i.test(clean))add(clean,'');else add(clean,'/api')}
   const origin=location.origin.replace(/\/$/,'');
   add(origin,'/api');
   add(origin+'/.netlify/functions/p2p','');
   return out;
 },
 url(ep,path){return ep.base+ep.prefix+(path.startsWith('/')?path:'/'+path)},
 userHeaders(json=true,extra={}){const h={'X-Owner-Key':p2pOwnerKey(),...extra};const init=telegramWebApp()?.initData||'';if(init)h['X-Telegram-Init-Data']=init;if(json)h['Content-Type']='application/json';return h},
 adminHeaders(json=true){const h={Authorization:'Bearer '+(window.OSCAR_TURSO_CONFIG?.adminToken||sessionStorage.getItem('oscar-turso-admin-token')||''),'X-Admin-Name':window.Admin?.user?.name||'admin'};if(json)h['Content-Type']='application/json';return h},
 async fetchJson(url,opt={},timeout=10000){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeout);try{const res=await fetch(url,{...opt,cache:'no-store',signal:ctrl.signal});const type=res.headers.get('content-type')||'';let data=null,raw='';if(type.includes('application/json')){try{data=await res.json()}catch{}}else{try{raw=(await res.text()).trim()}catch{}}return {res,data,raw}}catch(e){if(e?.name==='AbortError')throw new Error('انتهت مهلة الاتصال بنظام الدفع');throw e}finally{clearTimeout(timer)}},
 async resolveEndpoint(force=false){
   if(this._endpoint&&!force)return this._endpoint;
   let custom='';try{custom=String(S?.settings?.p2pApiBase||window.OSCAR_P2P_API_BASE||'').trim()}catch{custom=String(window.OSCAR_P2P_API_BASE||'').trim()}
   if(DirectTursoP2P.supported()){const ep={key:'local-turso-direct',direct:true,base:'turso-direct',prefix:''};this._endpoint=ep;this._health=await DirectTursoP2P.route('/health');return ep}
   if(LocalP2P.supported()&&!custom){const ep={key:'local-preview',local:true,base:'local-preview',prefix:''};this._endpoint=ep;this._health=await LocalP2P.route('/health');return ep}
   const errors=[];
   for(const ep of this.endpointCandidates()){
     try{
       const {res,data,raw}=await this.fetchJson(this.url(ep,'/health'),{method:'GET',headers:{'Accept':'application/json'}},6000);
       if(res.ok&&data?.ok){
         if(data.configured===false){errors.push('الـ API موجود لكن بيانات Turso غير مضافة في Environment Variables');continue}
         if(data.database===false){errors.push(data.database_error||'الـ API موجود لكن الاتصال بـ Turso فشل');continue}
         this._endpoint=ep;this._health=data;return ep;
       }
       errors.push((data?.error||raw||('HTTP '+res.status)).slice(0,180));
     }catch(e){errors.push(e.message||'تعذر الاتصال')}
   }
   if(LocalP2P.supported()){const ep={key:'local-preview',local:true,base:'local-preview',prefix:''};this._endpoint=ep;this._health=await LocalP2P.route('/health');return ep}
   const isGithub=/github\.io$/i.test(location.hostname);
   if(isGithub)throw new Error('المتجر منشور على GitHub Pages وهو لا يشغّل Backend. انشر p2p-worker.js على Cloudflare Worker وضع رابطه في إعداد «رابط P2P API».');
   throw new Error('تعذر تشغيل نظام الدفع P2P على الاستضافة الحالية. '+(errors.filter(Boolean)[0]||'تأكد من نشر ملفات الـ API وإعداد Turso.'));
 },
 async request(path,opt={},retry=true){
   const ep=await this.resolveEndpoint();
   if(ep?.direct)return DirectTursoP2P.route(path,opt);
   if(ep?.local)return LocalP2P.route(path,opt);
   let result;
   try{result=await this.fetchJson(this.url(ep,path),opt,20000)}catch(e){if(retry){this._endpoint=null;const next=await this.resolveEndpoint(true);result=await this.fetchJson(this.url(next,path),opt,20000)}else throw e}
   const {res,data,raw}=result;
   if(!res.ok){
     const msg=data?.error||data?.message||raw||('تعذر إكمال الطلب ('+res.status+')');
     // A bare platform Bad Request usually means the request never reached our P2P API.
     if(retry&&res.status===400&&!data&&/^bad request$/i.test(String(raw||''))){this._endpoint=null;try{const next=await this.resolveEndpoint(true);if(next.key!==ep.key)return this.request(path,opt,false)}catch{}}
     throw new Error(String(msg).slice(0,600));
   }
   if(!data)throw new Error('استجابة نظام الدفع غير صحيحة. أعد نشر ملفات P2P كاملة.');
   return data;
 },
 async health(){const ep=await this.resolveEndpoint(true);if(ep?.direct)return this._health||DirectTursoP2P.route('/health');if(ep?.local)return this._health||LocalP2P.route('/health');return this._health||{ok:true,endpoint:ep.base+ep.prefix}},
 async createOrder(productIds,couponCode=''){
   const checkoutKey=p2pCheckoutKey(productIds,couponCode);
   const body={product_ids:productIds,coupon_code:couponCode||'',local_user:localUserProfile(),checkout_key:checkoutKey};
   const data=await this.request('/orders',{method:'POST',headers:this.userHeaders(true,{'X-Checkout-Key':checkoutKey}),body:JSON.stringify(body)});
   if(data?.order?.id)clearP2PCheckoutKey();
   return data.order;
 },
 async myOrders(){return (await this.request('/orders',{headers:this.userHeaders(false)})).orders||[]},
 async order(id){return (await this.request('/orders/'+encodeURIComponent(id),{headers:this.userHeaders(false)})).order},
 async submitProof(id,data){return (await this.request('/orders/'+encodeURIComponent(id)+'/proof',{method:'POST',headers:this.userHeaders(),body:JSON.stringify(data)})).order},
 async notifications(){return (await this.request('/notifications',{headers:this.userHeaders(false)})).notifications||[]},
 async paymentMethods(){return (await this.request('/payment-methods',{headers:this.userHeaders(false)})).payment_methods||[]},
 async paymentMethod(id){return (await this.request('/payment-methods/'+encodeURIComponent(id),{headers:this.userHeaders(false)})).payment_method},
 async adminPaymentMethods(){return (await this.request('/admin/payment-methods',{headers:this.adminHeaders(false)})).payment_methods||[]},
 async savePaymentMethod(row){return (await this.request('/admin/payment-methods',{method:'POST',headers:this.adminHeaders(),body:JSON.stringify(row)})).payment_method},
 async deletePaymentMethod(id){return (await this.request('/admin/payment-methods/'+encodeURIComponent(id),{method:'DELETE',headers:this.adminHeaders(false)})).ok},
 async adminOrders(){return (await this.request('/admin/orders',{headers:this.adminHeaders(false)})).orders||[]},
 async adminOrder(id){return (await this.request('/admin/orders/'+encodeURIComponent(id),{headers:this.adminHeaders(false)})).order},
 async approve(id){return (await this.request('/admin/orders/'+encodeURIComponent(id)+'/approve',{method:'POST',headers:this.adminHeaders(),body:'{}'})).order},
 async reject(id,reason){return (await this.request('/admin/orders/'+encodeURIComponent(id)+'/reject',{method:'POST',headers:this.adminHeaders(),body:JSON.stringify({reason})})).order},
 async status(id,status){return (await this.request('/admin/orders/'+encodeURIComponent(id)+'/status',{method:'POST',headers:this.adminHeaders(),body:JSON.stringify({status})})).order}
};

function localUserProfile(){const tg=telegramProfile();if(tg)return {...tg,auth_provider:'telegram'};return {id:S.user?.id||'',name:S.user?.name||'',username:S.user?.username||'',phone:S.user?.phone||'',email:S.user?.email||'',auth_provider:S.user?.authProvider||'local'}}
async function telegramContinue(){
 const p=telegramProfile();
 if(!p){
  const username=String(S.settings.telegramBotUsername||'').replace(/^@/,'').trim();
  if(username){window.open('https://t.me/'+encodeURIComponent(username),'_blank','noopener');toast('افتح المتجر من داخل Telegram ثم اضغط متابعة عبر Telegram');}
  else openModal('متابعة عبر Telegram',`<p class="prose">افتح هذا المتجر من داخل Telegram Mini App ليتم جلب اسمك وصورتك وTelegram ID تلقائياً.<br>يمكن للمدير إضافة اسم البوت من إعدادات المتجر.</p>`);
  return;
 }
 const user={id:'tg-'+p.telegram_id,name:p.full_name,username:p.telegram_username||('telegram_'+p.telegram_id),phone:'',email:'',role:'customer',date:new Date().toISOString(),authProvider:'telegram',telegram:p,salt:'telegram',hash:'telegram'};
 await DB.put('users',user);localStorage.setItem('oscar-user',user.id);const old=S.owner;await migrateGuest(user,old);await refresh();location.hash='#/account';toast('تمت المتابعة بحساب Telegram');
}
async function compressProofImage(file){
 if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('اختر صورة JPG أو PNG أو WEBP');
 if(file.size>12*1024*1024)throw new Error('صورة الإثبات أكبر من 12 ميجابايت');
 const url=URL.createObjectURL(file);try{const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('تعذر قراءة صورة الإثبات'));i.src=url});const scale=Math.min(1,1200/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.width*scale));c.height=Math.max(1,Math.round(img.height*scale));c.getContext('2d').drawImage(img,0,0,c.width,c.height);return c.toDataURL('image/webp',.78)}finally{URL.revokeObjectURL(url)}
}
function paymentMethodImage(m){return m.image?`<img src="${esc(safeUrl(m.image))}" alt="${esc(m.name)}">`:`<div class="pay-method-placeholder">${icon('bag')}</div>`}
function paymentDetailRows(text){
 return String(text||'').split(/\n+/).map(x=>x.trim()).filter(Boolean).map(line=>{const idx=line.indexOf(':');const label=idx>=0?line.slice(0,idx).trim():'بيانات الدفع',value=idx>=0?line.slice(idx+1).trim():line;return `<div class="pay-detail-row"><div><small>${esc(label)}</small><strong dir="auto">${esc(value)}</strong></div>${value?`<button class="btn secondary small" data-action="copy-payment" data-value="${esc(value)}">${icon('copy')} نسخ</button>`:''}</div>`}).join('')
}
async function startP2PCheckout(singleId=''){
 if(!telegramProfile()&&!S.user){location.hash='#/login';toast('سجل الدخول أو تابع عبر Telegram قبل إنشاء الطلب');return}
 const ids=singleId?[singleId]:[...S.cart];if(!ids.length)throw new Error('السلة فارغة');
 const btn=document.activeElement?.closest?.('button');if(btn)btn.disabled=true;
 try{toast('جارٍ فحص نظام الدفع...');const health=await P2PAPI.health();if(health?.local_preview)toast('وضع محلي للتجربة — جارٍ إنشاء الطلب...');else toast('جارٍ إنشاء الطلب...');const coupon=singleId?'':(S.coupons.find(c=>c.id===S.coupon)?.code||'');const order=await P2PAPI.createOrder(ids,coupon);if(!order?.id)throw new Error('تم إنشاء الاتصال لكن لم يرجع رقم الطلب');S.coupon=null;const next='#/payment-methods/'+encodeURIComponent(order.id);if(location.hash===next)await render();else location.hash=next;toast('تم إنشاء الطلب، اختر طريقة الدفع')}catch(e){const wa=waURL('مرحباً فريق أوسكار البرمجي، حاولت إنشاء طلب شراء لكن نظام الدفع لم يفتح. أحتاج مساعدة.');openModal('تعذر إنشاء الطلب',`<p class="prose">${esc(e.message||'تعذر إنشاء الطلب')}</p><div class="hint mt">لن يتم اعتبار الطلب مدفوعاً أو حذف السلة حتى ينجح إنشاء الطلب.</div><div class="form-actions"><button class="btn secondary" data-action="close-modal">إغلاق</button><a class="btn" href="${esc(wa)}" target="_blank" rel="noopener">${icon('wa')} تواصل عبر واتساب</a></div>`)}finally{if(btn)btn.disabled=false}
}
async function paymentMethodsPage(orderId){
 let order;try{order=await P2PAPI.order(orderId)}catch(e){return `<div class="container page">${empty('تعذر فتح الطلب',e.message,false,'info')}</div>`}
 if(!['pending_payment','payment_rejected'].includes(order.status))return paymentSuccessOrStatus(order);
 let methods=[];try{methods=await P2PAPI.paymentMethods()}catch(e){return `<div class="container page">${pageHeading('اختيار طريقة الدفع')}<div class="hint">${esc(e.message)} — تأكد من إعداد رابط P2P API.</div></div>`}
 return `<div class="container page">${pageHeading('اختيار طريقة الدفع','اختر الطريقة المناسبة ثم أكمل التحويل')}<div class="order-mini panel"><div><small>رقم الطلب</small><strong dir="ltr">${esc(order.id)}</strong></div><div><small>المبلغ المطلوب</small><strong class="price">${money(order.total)}</strong></div></div>${order.status==='payment_rejected'?`<div class="payment-rejected"><strong>سبب رفض الإثبات السابق</strong><p>${esc(order.rejection_reason||'يرجى إعادة رفع إثبات صحيح.')}</p></div>`:''}<div class="payment-method-grid">${methods.map(m=>`<a class="payment-method-card" href="#/pay/${encodeURIComponent(order.id)}/${encodeURIComponent(m.id)}"><div class="payment-method-logo">${paymentMethodImage(m)}</div><div><h3>${esc(m.name)}</h3><p>${esc(m.description||'اضغط لعرض بيانات الدفع')}</p></div>${icon('chevron')}</a>`).join('')||empty('لا توجد طرق دفع مفعلة','يرجى التواصل مع فريق أوسكار البرمجي',false,'info')}</div></div>`
}
async function paymentPage(orderId,methodId){
 let order;try{order=await P2PAPI.order(orderId)}catch(e){return `<div class="container page">${empty('تعذر فتح الطلب',e.message,false,'info')}</div>`}
 let method;try{method=await P2PAPI.paymentMethod(methodId)}catch{return `<div class="container page">${empty('طريقة الدفع غير متاحة','اختر طريقة دفع أخرى',false,'info')}<a class="btn mt" href="#/payment-methods/${encodeURIComponent(orderId)}">رجوع لطرق الدفع</a></div>`;}
 if(!['pending_payment','payment_rejected'].includes(order.status))return paymentSuccessOrStatus(order);
 const proof=order.payment_proof||{};
 return `<div class="container page payment-page">${pageHeading('إتمام الدفع','حوّل المبلغ ثم أرسل إثبات الدفع للمراجعة')}<div class="payment-layout"><div><section class="panel pay-method-hero"><div class="pay-method-big">${paymentMethodImage(method)}</div><div><h2>${esc(method.name)}</h2><p>${esc(method.description||'')}</p></div></section><section class="panel mt"><h3>بيانات التحويل</h3><div class="pay-details mt">${paymentDetailRows(method.payment_details)}</div>${method.instructions?`<div class="hint prose">${esc(method.instructions)}</div>`:''}<div class="amount-due"><span>المبلغ المطلوب</span><strong>${money(order.total)}</strong></div></section><section class="panel mt"><h3>فاتورة الطلب</h3><div class="invoice-mini mt"><div class="summary-line"><span>رقم الطلب</span><strong dir="ltr">${esc(order.id)}</strong></div>${order.items.map(i=>`<div class="summary-line"><span>${esc(i.product_name||i.name)} × ${i.quantity||1}</span><strong>${money(i.subtotal??i.price)}</strong></div>`).join('')}<div class="summary-line summary-total"><span>الإجمالي</span><strong>${money(order.total)}</strong></div><div class="summary-line"><span>طريقة الدفع</span><strong>${esc(method.name)}</strong></div></div></section></div><aside class="panel proof-panel"><h3>تأكيد الدفع</h3>${order.status==='payment_rejected'?`<div class="payment-rejected"><strong>تم رفض الإثبات السابق</strong><p>${esc(order.rejection_reason||'')}</p></div>`:''}<form id="payment-proof-form" data-order="${esc(order.id)}" data-method="${esc(method.id)}"><div class="form-grid single">${field('sender_account_name','اسم الحساب الذي تم التحويل منه',proof.sender_account_name||'','text',{required:true,full:true})}<label class="field full"><span>${icon('image')} صورة إشعار الدفع *</span><input id="payment-proof-file" type="file" accept="image/jpeg,image/png,image/webp" required><small>سيتم ضغط الصورة تلقائياً إلى حد أقصى 1200px قبل الإرسال.</small></label><div id="payment-proof-preview" class="proof-preview full">${proof.proof_image?`<img src="${esc(safeUrl(proof.proof_image))}" alt="إثبات الدفع السابق">`:''}</div></div><div class="payment-warning">${icon('info')} تأكد من تحويل المبلغ الصحيح إلى بيانات الدفع الموضحة أعلاه قبل إرسال إثبات الدفع. إرسال الإثبات لا يعني قبول الدفع حتى يراجعه المدير.</div><button class="btn wfull proof-submit" type="submit">${icon('upload')} لقد دفعت</button><p class="error-text" id="payment-proof-error"></p></form></aside></div></div>`
}
function paymentSuccessOrStatus(order){
 const st=p2pStatusLabel(order.status);const success=order.status==='payment_review';return `<div class="container page"><div class="panel payment-success">${icon(success?'check':'clock')}<h1>${success?'تم إرسال إثبات الدفع بنجاح':esc(st)}</h1><p>${success?'طلبك الآن قيد المراجعة. سنقوم بتحديث حالته بعد مراجعة التحويل.':'حالة الطلب الحالية: '+esc(st)}</p><div class="order-number"><small>رقم الطلب</small><strong dir="ltr">${esc(order.id)}</strong></div>${order.rejection_reason?`<div class="payment-rejected"><strong>سبب الرفض</strong><p>${esc(order.rejection_reason)}</p></div>`:''}<div class="row center-actions"><a class="btn" href="#/orders">عرض طلبي</a><a class="btn secondary" href="#/">العودة للرئيسية</a></div></div></div>`
}
async function p2pOrdersPage(){
 let rows=[];try{rows=await P2PAPI.myOrders()}catch(e){return `<div class="container page">${pageHeading('طلباتي')}<div class="hint">${esc(e.message)} — تأكد من إعداد رابط P2P API في لوحة الإدارة.</div></div>`}
 return `<div class="container page">${pageHeading('طلباتي','تابع حالة الدفع والتنفيذ')}${rows.length?rows.map(o=>`<article class="panel order"><div class="order-head"><div><strong dir="ltr">${esc(o.id)}</strong><p class="small">${dateLabel(o.created_at||o.date)}</p></div><span class="pill status-${esc(o.status)}">${esc(p2pStatusLabel(o.status))}</span></div><div class="order-lines">${o.items.map(i=>`<span class="chip">${esc(i.product_name||i.name)}</span>`).join('')}</div>${o.status==='payment_rejected'?`<div class="payment-rejected"><strong>سبب الرفض</strong><p>${esc(o.rejection_reason||'')}</p></div>`:''}<div class="row between wrap"><strong class="price">${money(o.total)}</strong><div class="row wrap"><button class="btn secondary small" data-action="order-detail" data-id="${esc(o.id)}">تفاصيل</button>${['pending_payment','payment_rejected'].includes(o.status)?`<a class="btn small" href="#/payment-methods/${encodeURIComponent(o.id)}">${o.status==='payment_rejected'?'إعادة رفع الإثبات':'إكمال الدفع'}</a>`:''}</div></div></article>`).join(''):empty('لا توجد طلبات حتى الآن','أضف تطبيقاً إلى السلة ثم اضغط شراء الآن',true,'bag')}</div>`
}
async function p2pOrderDetail(id){const o=await P2PAPI.order(id);const tg=o.telegram||{};openModal('تفاصيل الطلب',`<div class="invoice-mini"><div class="summary-line"><span>رقم الطلب</span><strong dir="ltr">${esc(o.id)}</strong></div><div class="summary-line"><span>الحالة</span><strong>${esc(p2pStatusLabel(o.status))}</strong></div>${o.items.map(i=>`<div class="summary-line"><span>${esc(i.product_name||i.name)}</span><strong>${money(i.subtotal??i.price)}</strong></div>`).join('')}<div class="summary-line summary-total"><span>الإجمالي</span><strong>${money(o.total)}</strong></div>${o.payment_method_name?`<div class="summary-line"><span>طريقة الدفع</span><strong>${esc(o.payment_method_name)}</strong></div>`:''}</div>${o.rejection_reason?`<div class="payment-rejected"><strong>سبب الرفض</strong><p>${esc(o.rejection_reason)}</p></div>`:''}${tg.telegram_id?`<div class="telegram-profile mt">${tg.photo_url?`<img src="${esc(safeUrl(tg.photo_url))}" alt="">`:icon('user')}<div><strong>${esc(tg.full_name||'')}</strong><p dir="ltr">@${esc(tg.telegram_username||'—')} · ${esc(tg.telegram_id)}</p></div></div>`:''}`)}
function telegramProfileCard(){const p=telegramProfile()||S.user?.telegram;if(!p)return '';return `<div class="telegram-profile"><div class="telegram-avatar">${p.photo_url?`<img src="${esc(safeUrl(p.photo_url))}" alt="${esc(p.full_name||'Telegram')}">`:icon('user')}</div><div><strong>${esc(p.full_name||S.user?.name||'Telegram')}</strong><p dir="ltr">${p.telegram_username?'@'+esc(p.telegram_username)+' · ':''}${esc(p.telegram_id||'')}</p><small>حساب Telegram متصل</small></div></div>`}
async function bindP2PPage(){
 const form=$('#payment-proof-form');if(form){let proof='';const file=$('#payment-proof-file');file.onchange=async()=>{try{proof=await compressProofImage(file.files[0]);$('#payment-proof-preview').innerHTML=`<img src="${proof}" alt="معاينة إثبات الدفع">`}catch(e){file.value='';proof='';fail(e)}};form.onsubmit=async e=>{e.preventDefault();const btn=form.querySelector('button[type=submit]');btn.disabled=true;const original=btn.innerHTML;btn.textContent='جارٍ إرسال إثبات الدفع...';try{const d=Object.fromEntries(new FormData(form));if(!String(d.sender_account_name||'').trim())throw new Error('اكتب اسم الحساب الذي تم التحويل منه');if(!proof)throw new Error('ارفع صورة إثبات الدفع');const order=await P2PAPI.submitProof(form.dataset.order,{payment_method_id:form.dataset.method,sender_account_name:String(d.sender_account_name).trim(),proof_image:proof});const orderedIds=new Set(order.items.map(i=>i.product_id||i.id));S.cart=S.cart.filter(id=>!orderedIds.has(id));await DB.put('carts',{id:S.owner,items:S.cart});location.hash='#/payment-success/'+encodeURIComponent(order.id);toast('تم إرسال إثبات الدفع للمراجعة')}catch(err){$('#payment-proof-error').textContent=err.message;btn.disabled=false;btn.innerHTML=original}}}
}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b)return;try{if(b.dataset.action==='telegram-login')await telegramContinue();else if(b.dataset.action==='copy-payment'){await navigator.clipboard.writeText(b.dataset.value||'');toast('تم النسخ')}else if(b.dataset.action==='order-detail'){e.stopImmediatePropagation();await p2pOrderDetail(b.dataset.id)}}catch(err){fail(err)}},true);
