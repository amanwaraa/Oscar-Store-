const CACHE='oscar-shell-v3.8.0-turso-clean';
const CORE=['./','index.html','admin.html','styles.css?v=3.8.0','db.js?v=3.8.0','data.js?v=3.8.0','app.js?v=3.8.0','p2p.js?v=3.8.0','admin.js?v=3.8.0','p2p-admin.js?v=3.8.0','manifest.json','icon-192.png','icon-512.png','oscar-logo-symbol.png','oscar-logo-full.jpg','hero.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('oscar-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  if(url.origin!==location.origin)return;
  if(url.pathname==='/api'||url.pathname.startsWith('/api/')||url.pathname.startsWith('/.netlify/functions/p2p'))return;
  if(e.request.mode==='navigate'){
    const fallback=/\/admin\.html$/i.test(url.pathname)?'admin.html':'index.html';
    e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{if(r.ok)caches.open(CACHE).then(c=>c.put(fallback,r.clone()));return r}).catch(()=>caches.match(fallback)));
    return;
  }
  if(/\.(?:js|css)$/i.test(url.pathname)){
    e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{if(r.ok)caches.open(CACHE).then(c=>c.put(e.request,r.clone()));return r}).catch(()=>caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(r=>{if(r.ok)caches.open(CACHE).then(c=>c.put(e.request,r.clone()));return r})));
});
