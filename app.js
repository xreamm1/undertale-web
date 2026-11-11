const $ = id => document.getElementById(id);
const CACHE = 'undertale-cache-v1';
let runner, database, battle = false, started = false, ready = false;
let lastSaves = '', saveTimer, relativeX = 0, relativeY = 0;
let fatal = false;
const logLines = [];
const held = new Map(), points = new Map();
const saveNames = /^(file\d+|undertale\.ini|system_information_\d+|config\.ini)$/i;
function log(text) {
  logLines.push(String(text));
  if(logLines.length>80)logLines.shift();
  if(!started)$('startup-log').textContent=logLines.join('\n');
}
const report = text => { $(started ? 'play-status' : 'status').textContent = text; log(text); };
function failRuntime(reason) {
  if(fatal)return;
  fatal=true;
  const message=reason ? String(reason) : 'Раннер аварийно завершился';
  report('Ошибка игры: '+message);
  $('error-message').textContent='Ошибка игры: '+message;
  $('error-log').textContent=logLines.join('\n');
  $('error-panel').hidden=false;
  clearInterval(saveTimer);
  releaseAll();
}
const resourceState = {module:{loaded:0,total:2141967},memory:{loaded:0,total:0},archives:{loaded:0,total:0},chunks:{loaded:0,total:0},boot:{loaded:0,total:5}};
function progressRow(name, loaded, total = resourceState[name].total) {
  resourceState[name] = {loaded,total};
  $(name+'-progress').max = Math.max(1,total);
  $(name+'-progress').value = loaded;
  $(name+'-value').textContent = ['module','memory','archives'].includes(name)
    ? `${(loaded/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB` : `${loaded} / ${total}`;
  const resources = ['module','memory','archives'].map(key=>resourceState[key]);
  const bytes = resources.reduce((sum,item)=>sum+item.loaded,0), allBytes = resources.reduce((sum,item)=>sum+item.total,0);
  const complete = allBytes ? (bytes/allBytes)*.95 + (resourceState.boot.loaded/5)*.05 : 0;
  const percent = Math.min(100,Math.floor(complete*100));
  $('progress').value=percent;$('percent').textContent=percent+'%';
}

function openDatabase() {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open('undertale-web-saves',1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function store(mode, callback) {
  return new Promise((resolve,reject) => {
    const transaction = database.transaction('snapshots',mode);
    const request = callback(transaction.objectStore('snapshots'));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || Error('Сохранение прервано'));
  });
}
function snapshot() {
  const files = Object.create(null);
  for (const name of runner.FS.readdir('/saves').sort()) {
    if (saveNames.test(name)) files[name] = Array.from(runner.FS.readFile('/saves/' + name));
  }
  return files;
}
async function syncSaves() {
  if (!runner || !database || !started || fatal) return;
  const files = snapshot(), serialized = JSON.stringify(files);
  if (serialized === lastSaves) return;
  // Capture all files in one transaction so deletions are mirrored as well.
  await store('readwrite', target => target.put(files,'current'));
  lastSaves = serialized;
}
function validateSave(value) {
  if (!value || value.format !== 'undertale-web-save-v1' || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw Error('Неверный формат сейва');
  const entries = Object.entries(value.files);
  if (entries.length > 32) throw Error('Слишком много файлов');
  for (const [name,bytes] of entries) {
    if (!saveNames.test(name) || !Array.isArray(bytes) || bytes.length > 1024*1024 || !bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) throw Error('Повреждённый сейв: ' + name);
  }
  return value.files;
}
async function prepareWorker() {
  if (!('serviceWorker' in navigator)) throw Error('Для офлайн-режима нужен браузер с Service Worker и HTTPS');
  await navigator.serviceWorker.register('./sw.js', {scope:'./',updateViaCache:'none'});
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((resolve,reject) => {
    const timeout = setTimeout(() => reject(Error('Service Worker не получил управление. Обновите страницу.')),15000);
    navigator.serviceWorker.addEventListener('controllerchange',() => {clearTimeout(timeout);resolve();},{once:true});
  });
}
async function download(file, onBytes, game = true) {
  if (!(game ? /^game\/[\w.-]+$/ : /^runtime\/butterscotch\.wasm$/).test(file.path) || !Number.isSafeInteger(file.size) || file.size < 1) throw Error('Неверный манифест ресурсов');
  const url = new URL(file.path,location.href);
  const cache = await caches.open(CACHE);
  let response = await cache.match(url.href);
  const cached = !!response;
  response ||= await fetch(url);
  if (!response.ok || !response.body) throw Error(`Не удалось загрузить ${file.path}: HTTP ${response.status}`);
  const bytes = new Uint8Array(file.size);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) throw Error('Размер ресурса не совпадает: ' + file.path);
      bytes.set(value,offset);offset += value.length;onBytes(value.length);
    }
  } finally { reader.releaseLock(); }
  if (offset !== file.size) throw Error('Ресурс загружен не полностью: ' + file.path);
  if (!cached) await cache.put(url.href,new Response(bytes,{headers:{'Content-Type':file.path.endsWith('.ogg')?'audio/ogg':'application/octet-stream'}}));
  if(game)runner.FS.writeFile('/' + file.path,bytes);
  return bytes;
}
async function prepare() {
  $('retry').hidden = true;
  try {
    $('device-info').textContent=`Browser · ${navigator.hardwareConcurrency || '?'} logical cores · 3 parallel downloads · Cache First`;
    const manifestResponse = await fetch('./assets.json');
    if (!manifestResponse.ok) throw Error('Манифест ресурсов недоступен');
    const manifest = await manifestResponse.json();
    if (!Array.isArray(manifest.files) || !manifest.files.some(file => file.path === 'game/data.win')) throw Error('В манифесте нет data.win');
    progressRow('memory',0,manifest.files.find(file=>file.path==='game/data.win').size);
    progressRow('archives',0,manifest.files.filter(file=>file.path!=='game/data.win').reduce((sum,file)=>sum+file.size,0));
    progressRow('chunks',0,manifest.files.length);
    await prepareWorker();
    progressRow('boot',1);
    database ||= await openDatabase();
    progressRow('boot',2);
    report('Загрузка WebAssembly');
    const wasmBytes = await download({path:'runtime/butterscotch.wasm',size:resourceState.module.total},amount=>progressRow('module',resourceState.module.loaded+amount),false);
    const compiled = await WebAssembly.compile(wasmBytes);
    const {default:createRunner} = await import('./runtime/butterscotch.mjs');
    let rejectInstantiation;
    const instantiationFailure = new Promise((_,reject)=>{rejectInstantiation=reject;});
    runner ||= await Promise.race([createRunner({canvas:$('canvas'),audioBufferFrames:4096,
      instantiateWasm(imports,receive){WebAssembly.instantiate(compiled,imports).then(instance=>receive(instance)).catch(rejectInstantiation);return {};},
      print:line => {log(line);console.info('[Runner]',line);},printErr:line => {log(line);console.warn('[Runner]',line);},onAbort:failRuntime}),instantiationFailure]);
    log('Audio: 4096-frame output buffer; native mixer block size preserved');
    progressRow('boot',3);
    runner.FS.mkdirTree('/game');runner.FS.mkdirTree('/saves');
    const total = manifest.files.reduce((sum,file) => sum + file.size,0);
    let loaded = 0, cursor = 0;
    const update = (file,amount) => {
      loaded += amount;
      const group = file.path==='game/data.win'?'memory':'archives';
      progressRow(group,resourceState[group].loaded+amount);
      $('status').textContent = 'Загрузка игровых ресурсов';
      $('detail').textContent = `${(loaded/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} МБ · ${manifest.files.length} файлов`;
    };
    await Promise.all(Array.from({length:3},async () => {
      while(cursor < manifest.files.length){
        const file=manifest.files[cursor++];
        await download(file,amount=>update(file,amount));
        progressRow('chunks',resourceState.chunks.loaded+1);
      }
    }));
    progressRow('boot',4);
    const saves = await store('readonly',target => target.get('current'));
    if (saves) for(const [name,bytes] of Object.entries(validateSave({format:'undertale-web-save-v1',files:saves}))) runner.FS.writeFile('/saves/' + name,new Uint8Array(bytes));
    lastSaves = JSON.stringify(snapshot());
    runner.FS.chdir('/game');
    ready = true;progressRow('boot',5);
    report('Запуск игры…');
    $('cache-state').textContent = 'ИГРА СОХРАНЕНА В КЭШ';
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    startGame();
  } catch(error) {
    report(error.message);$('retry').hidden = false;$('cache-state').textContent = 'ОШИБКА ЗАГРУЗКИ';console.error(error);
  }
}
function resumeAudio() {
  if(fatal)return;
  const devices = window.miniaudio?.devices || [];
  for (const device of Object.values(devices)) {
    const context=device?.webaudio;
    if(context && ['suspended','interrupted'].includes(context.state))context.resume().catch(console.warn);
  }
}
async function fullscreen() {
  resumeAudio();
  if(document.fullscreenElement){
    try{await document.exitFullscreen();}catch{report('Не удалось выйти из полноэкранного режима.');}
    return;
  }
  try{
    if(!document.body.requestFullscreen)throw Error('Fullscreen unavailable');
    await document.body.requestFullscreen();
    $('controls').hidden=true;$('settings').setAttribute('aria-expanded','false');
  }catch{
    report('Полноэкранный режим недоступен. Поверните телефон горизонтально.');
    $('orientation-hint').hidden=!matchMedia('(orientation: portrait)').matches;
    return;
  }
  try{
    if(!screen.orientation?.lock)throw Error('Orientation lock unavailable');
    await screen.orientation.lock('landscape');
    $('orientation-hint').hidden=true;
  }catch{
    $('orientation-hint').hidden=!matchMedia('(orientation: portrait)').matches;
  }
}
function setKeys(source, values) {
  if(fatal){held.clear();return;}
  const previous = new Set([...held.values()].flat());
  if(values.length) held.set(source,values);else held.delete(source);
  const next = new Set([...held.values()].flat());
  for(const code of previous) if(!next.has(code)) runner?._onKeyUp(code);
  for(const code of next) if(!previous.has(code)) runner?._onKeyDown(code);
}
function drawStick(point,dx=0,dy=0) {
  const stick=$('stick');
  stick.classList.toggle('active',!!point);
  if(point){const rect=$('touch').getBoundingClientRect();stick.style.left=(point.startX-rect.left)+'px';stick.style.top=(point.startY-rect.top)+'px';stick.style.bottom='auto';}
  else{stick.style.left='';stick.style.top='';stick.style.bottom='';}
  const length=Math.hypot(dx,dy),scale=length>32?32/length:1;
  stick.firstElementChild.style.transform=`translate(${dx*scale}px,${dy*scale}px)`;
}
function releaseAll() { for(const point of points.values())clearTimeout(point.holdTimer);for(const source of [...held.keys()]) setKeys(source,[]);points.clear();relativeX=relativeY=0;drawStick(null); }
function tap(code) {setKeys('tap',[code]);setTimeout(() => setKeys('tap',[]),90);}
function switchMode(value) {
  releaseAll();battle=value;$('mode').textContent='РЕЖИМ: '+(battle?'БОЙ':'МИР');$('mode').setAttribute('aria-pressed',String(battle));
  document.body.classList.toggle('battle',battle);
  report(battle?'Води пальцем в любой части экрана, в том числе по чёрным полям. Справа удержание — X.':'Слева — стик. Справа — тап Z, удержание X.');
}
// The stock runner exposes keyboard input, not soul position or HP. An instrumented build can report these events.
window.UndertaleShell = {setBattle:switchMode,damage:() => navigator.vibrate?.(25)};
const touch = $('touch');
touch.addEventListener('pointerdown',event => {
  if(!started || fatal || event.pointerType === 'mouse') return;
  event.preventDefault();touch.setPointerCapture(event.pointerId);resumeAudio();
  const rect=touch.getBoundingClientRect();
  const point={x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,right:event.clientX > rect.left+rect.width/2,moved:false,holding:false};
  points.set(event.pointerId,point);
  if(!battle&&!point.right)drawStick(point);
  if(point.right)point.holdTimer=setTimeout(()=>{if(!point.moved && points.has(event.pointerId)){point.holding=true;setKeys('hold-'+event.pointerId,[88]);}},300);
});
touch.addEventListener('pointermove',event => {
  const point=points.get(event.pointerId);if(!point)return;event.preventDefault();
  const rect=touch.getBoundingClientRect();
  if(Math.hypot(event.clientX-point.startX,event.clientY-point.startY)>8){point.moved=true;clearTimeout(point.holdTimer);}
  if(battle && !point.holding){
    const scale=Math.min(rect.width/640,rect.height/480);
    relativeX+=(event.clientX-point.x)/scale;relativeY+=(event.clientY-point.y)/scale;
  }
  else if(!point.right){
    const dx=event.clientX-point.startX,dy=event.clientY-point.startY,keys=[];
    if(Math.abs(dx)>12)keys.push(dx<0?37:39);if(Math.abs(dy)>12)keys.push(dy<0?38:40);
    setKeys('joystick-'+event.pointerId,keys);
    drawStick(point,dx,dy);
  }
  point.x=event.clientX;point.y=event.clientY;
});
function endPointer(event) {
  const point=points.get(event.pointerId);if(!point)return;
  clearTimeout(point.holdTimer);
  if(event.type==='pointerup'&&point.right&&!point.moved&&!point.holding)tap(90);
  points.delete(event.pointerId);setKeys('joystick-'+event.pointerId,[]);
  setKeys('hold-'+event.pointerId,[]);
  if(!point.right)drawStick([...points.values()].find(p=>!p.right)||null);
  if(!points.size){relativeX=relativeY=0;setKeys('relative',[]);}
}
for(const event of ['pointerup','pointercancel','lostpointercapture'])touch.addEventListener(event,endPointer);
let previousFrame=0;
function animate(time){
  const dt=Math.min(34,time-previousFrame||16);previousFrame=time;
  if(battle && started && !fatal){
    // Keyboard-only approximation at Undertale's usual 30 fps; direct position control needs a runner hook.
    const step=120*dt/1000,keys=[];
    if(Math.abs(relativeX)>.5){keys.push(relativeX<0?37:39);relativeX-=Math.sign(relativeX)*Math.min(Math.abs(relativeX),step);}
    if(Math.abs(relativeY)>.5){keys.push(relativeY<0?38:40);relativeY-=Math.sign(relativeY)*Math.min(Math.abs(relativeY),step);}
    setKeys('relative',keys);
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
window.addEventListener('keydown',event => {
  if(!started || ![37,38,39,40,90,88,67,13,16,17,27].includes(event.keyCode))return;
  event.preventDefault();if(!event.repeat)setKeys('keyboard-'+event.code,[event.keyCode]);resumeAudio();
});
window.addEventListener('keyup',event=>setKeys('keyboard-'+event.code,[]));
window.addEventListener('blur',releaseAll);
document.addEventListener('visibilitychange',()=>{if(document.hidden){releaseAll();syncSaves().catch(error=>report(error.message));}});
for(const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('pointerdown',event=>{if(!started)return;event.preventDefault();button.setPointerCapture(event.pointerId);setKeys('button-'+button.dataset.key,[Number(button.dataset.key)]);resumeAudio();});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,()=>setKeys('button-'+button.dataset.key,[]));
}
function startGame() {
  if(!ready||started)return;
  started=true;document.body.classList.add('playing');$('launcher').hidden=true;$('player').hidden=false;
  resumeAudio();
  const args=['--save-folder','/saves','/game/data.win'];
  const pointers=args.map(value=>runner.stringToNewUTF8(value));
  const argv=runner._malloc(pointers.length*4);pointers.forEach((pointer,index)=>runner.setValue(argv+index*4,pointer,'i32'));
  runner.ccall('startRunner','number',['number','number'],[pointers.length,argv],{async:true}).then(()=>report('Игра завершена. Обновите страницу для нового запуска.')).catch(failRuntime).finally(()=>{if(!fatal){pointers.forEach(pointer=>runner._free(pointer));runner._free(argv);}});
  saveTimer=setInterval(()=>syncSaves().catch(error=>report('Не удалось сохранить: '+error.message)),1000);
  $('canvas').focus();
}
let persistentRequested=false;
function unlockOnGesture(){
  if(!started)return;
  resumeAudio();
  if(!persistentRequested){persistentRequested=true;navigator.storage?.persist?.().catch(console.warn);}
}
window.addEventListener('pointerdown',unlockOnGesture,{capture:true,passive:true});
window.addEventListener('keydown',unlockOnGesture,{capture:true});
$('mode').onclick=()=>switchMode(!battle);
$('settings').onclick=()=>{
  releaseAll();$('controls').hidden=!$('controls').hidden;
  $('settings').setAttribute('aria-expanded',String(!$('controls').hidden));
  resumeAudio();
};
$('sound').onclick=()=>{resumeAudio();report('Звук включён, если разрешён браузером.');};
$('fullscreen').onclick=fullscreen;
document.addEventListener('fullscreenchange',()=>{
  const active=!!document.fullscreenElement;
  $('fullscreen').textContent=active?'ВЫЙТИ ИЗ ПОЛНОГО ЭКРАНА':'НА ВЕСЬ ЭКРАН';
  if(!active){
    try{screen.orientation?.unlock?.();}catch{}
    $('orientation-hint').hidden=true;
  }
  releaseAll();
});
matchMedia('(orientation: landscape)').addEventListener('change',event=>{
  if(event.matches)$('orientation-hint').hidden=true;
  releaseAll();
});
$('retry').onclick=()=>location.reload();
$('restart').onclick=()=>location.reload();
$('export').onclick=async()=>{
  try{
    await syncSaves();
    const blob=new Blob([JSON.stringify({format:'undertale-web-save-v1',files:snapshot()},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='undertale-save.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){report(error.message);}
};
$('import').onchange=async event=>{
  try{
    const file=event.target.files[0];if(!file)return;if(file.size>8*1024*1024)throw Error('Сейв слишком большой');
    const files=validateSave(JSON.parse(await file.text()));
    // Apply on reload so the running game's in-memory state cannot overwrite imported data.
    clearInterval(saveTimer);releaseAll();await store('readwrite',target=>target.put(files,'current'));location.reload();
  }catch(error){report(error.message);}
};
prepare();
