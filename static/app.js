/* =====================================================================
   STS OrderDesk — frontend logic
   Data quality rules:
   - AI-read orders NEVER enter the checklist silently: they land in a
     review modal with the server's arithmetic cross-checks first.
   - Lines the model marked medium/low confidence are highlighted.
   - Lines without a catalogue weight are highlighted amber and accept a
     manual weight so the dispatch estimate is never silently short.
===================================================================== */

/* ---------- STS catalogue weight tables (kg per valve) ---------- */
const WEIGHTS = {
  gate:  {50:8.9, 65:12.3, 80:14.8, 100:19.5, 125:23.5, 150:30.5, 200:50,
          250:78.6, 300:108, 350:169, 400:209, 450:300, 500:390, 600:648,
          800:1050, 1000:1620, 1200:2350},
  air:   {25:5.125, 40:12.5, 50:13.03, 80:17.5, 100:22.5, 150:48, 200:53},
  check: {50:8, 65:10.5, 80:13.8, 100:20, 125:26.8, 150:31.4, 200:70.4,
          250:107.9, 300:172, 350:239.3, 400:320, 450:396, 500:556, 600:851}
};
const CAT_LABEL = {gate:'GATE', air:'AIR', check:'NRV', other:'—'};
const CATNAME = {gate:'DI Resilient Seated Gate Valve', air:'DI Air Valve',
                 check:'DI Non Return Valve', other:'Other item'};
const STATUS = ['To make','In production','Packed'];
const DEFAULT_GST = 18;           // standard rate for valves (HSN 8481)

let lines    = [];    // {id, desc, cat, dn, pn, qty, rate, gst, wOv, status, source, conf, note}
let charges  = [];    // additional charges from POs: {desc, amount, tax_percent, tax_amount}
let pending  = null;  // extraction waiting in the review modal
let view     = 'lines';
let uid      = 1;

/* ---------- classification & weights ---------- */
function classify(desc){
  const d = (desc||'').toLowerCase();
  if (/(nrv|non[\s-]*return|check\s*valve|swing|tilting|dual\s*plate|reflux)/.test(d)) return 'check';
  if (/(air\s*valve|kinetic|scavr|triple\s*function|single\s*chamber|double\s*chamber)/.test(d)) return 'air';
  if (/(gate\s*valve|sluice)/.test(d)) return 'gate';
  return 'other';
}
/* Fallback DN parser — used when the extractor left dn empty */
function parseDN(desc){
  const d = (desc||'').toLowerCase();
  let m = d.match(/\bdn\s*[- ]?(\d{2,4})\b/);          if(m) return +m[1];
  m = d.match(/\b(\d{2,4})\s*(?:mm|nb)\b/);            if(m) return +m[1];
  m = d.match(/\b(\d+(?:\.\d+)?)\s*(?:"|inch|in\b)/);  if(m){
    const inch=+m[1];
    const map={2:50,2.5:65,3:80,4:100,6:150,8:200,10:250,12:300,14:350,16:400,18:450,20:500,24:600};
    return map[inch] ?? Math.round(inch*25);
  }
  return null;
}
function unitWeight(l){
  if(l.wOv!=null) return l.wOv;                 // manual override wins
  const t = WEIGHTS[l.cat]; if(!t||l.dn==null) return null;
  return t[l.dn] ?? null;
}
const fmtKg = k => k==null ? '—' : (Math.round(k*10)/10).toLocaleString('en-IN',{minimumFractionDigits:1,maximumFractionDigits:1});
const fmtIN = n => n==null||isNaN(n) ? '' : Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});
const esc = s => String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------- sample POs (from real STS documents) ---------- */
const SAMPLES = {
  ufe1: {name:'Utkal Foundry & Engineering Co Pvt Ltd', ref:'001/UFE/2026-27', date:'14.05.2026',
    items:[
      ['DI Resilient Seated Gate Valve, PN 16',100,16,150,5856],
      ['DI Resilient Seated Gate Valve, PN 16',150,16,80,9000],
      ['DI Resilient Seated Gate Valve, PN 16 (8 holes)',200,16,50,14453],
      ['DI Resilient Seated Gate Valve, PN 16',250,16,20,25019],
      ['DI Resilient Seated Gate Valve, PN 16',300,16,15,31397],
      ['DI Resilient Seated Gate Valve, PN 16',350,16,8,66340],
      ['DI Resilient Seated Gate Valve, PN 16',400,16,6,85920],
      ['DI Air Valve',25,16,20,4200],
      ['DI Air Valve',50,16,40,7821],
      ['DI Air Valve',100,16,42,12810],
      ['DI Air Valve',150,16,10,19198],
      ['DI Non Return Valve',100,16,15,7135],
      ['DI Non Return Valve',150,16,13,12516],
      ['DI Non Return Valve',200,16,8,25037],
      ['DI Non Return Valve',250,16,5,42409],
      ['DI Non Return Valve',300,16,5,65924]]},
  ufe2: {name:'Utkal Foundry & Engineering Co Pvt Ltd', ref:'002/UFE/2026-27', date:'14.05.2026',
    items:[
      ['DI Air Valve',25,16,13,4200],
      ['DI Air Valve',50,16,7,7821],
      ['DI Resilient Seated Gate Valve, PN 16',80,16,2,4442],
      ['DI Resilient Seated Gate Valve, PN 16',100,16,16,5856],
      ['DI Resilient Seated Gate Valve, PN 16',150,16,17,9000],
      ['DI Resilient Seated Gate Valve, PN 16 (8 hole)',200,16,4,14453]]},
  upfp: {name:'Utkal Pipes Fittings & Pumps', ref:'005/UP/2026-27', date:'14.05.2026',
    items:[
      ['DI Resilient Seated Gate Valve, PN 16 (HW) New',100,16,134,5856],
      ['DI Resilient Seated Gate Valve, PN 16 (HW) New',150,16,50,9000],
      ['DI Resilient Seated Gate Valve, PN 16 (HW) New (8 holes)',200,16,25,14453],
      ['DI Resilient Seated Gate Valve, PN 16 (HW) New',250,16,15,25019],
      ['DI Resilient Seated Gate Valve, PN 16 (HW) New',300,16,5,31397],
      ['DI Resilient Seated Gate Valve, PN 16 (HW) New',500,16,1,172281],
      ['DI Air Valve',50,16,10,7821],
      ['DI Air Valve',80,16,5,11627],
      ['DI Air Valve',100,16,5,12810],
      ['DI Non Return Valve',250,16,4,42409]]}
};

/* ---------- DOM ---------- */
const $ = s => document.querySelector(s);
const tbl = $('#tbl'), thead = tbl.querySelector('thead'), tbody = tbl.querySelector('tbody');
const msg = $('#msg');
let msgTimer = null;
function setMsg(kind, html){
  clearTimeout(msgTimer);
  msg.className = 'status-msg show ' + kind;
  msg.innerHTML = html;
  if(kind==='ok') msgTimer = setTimeout(()=>msg.classList.remove('show'), 5000);
}

/* ---------- add lines ---------- */
function addLines(order){
  order.items.forEach(it=>{
    let [desc,dn,pn,qty,rate,gst,conf,note] = Array.isArray(it)
      ? [it[0],it[1],it[2],it[3],it[4],DEFAULT_GST,'high',null]
      : [it.description||it.desc||'Item', it.dn, it.pn, it.qty, it.rate,
         it.gst_percent ?? order.gst ?? DEFAULT_GST, it.confidence||'high', it.note||null];
    const cat = classify(desc);
    if(dn==null) dn = parseDN(desc);
    lines.push({id:uid++, desc, cat, dn:dn!=null?+dn:null, pn:pn!=null?+pn:16,
      qty:+qty||0, rate:rate!=null?+rate:null, gst:gst!=null?+gst:DEFAULT_GST,
      wOv:null, status:0, source:order.ref||order.name||'', conf, note});
  });
  render();
}

/* ---------- render ---------- */
function render(){
  const has = lines.length>0;
  $('#nolines').style.display = has?'none':'block';
  tbl.style.display = has?'table':'none';
  $('#lineCount').textContent = lines.length + (lines.length===1?' line':' lines');

  if(view==='lines'){
    thead.innerHTML = `<tr><th>#</th><th>Status</th><th>Description</th>
      <th class="num">DN</th><th class="num">PN</th><th class="num">Qty</th>
      <th class="num">Wt/pc kg</th><th class="num">Total kg</th>
      <th class="num">Rate ₹</th><th class="num">Amount ₹</th><th class="num">GST %</th>
      <th>PO ref</th><th></th></tr>`;
    tbody.innerHTML = lines.map((l,i)=>{
      const uw = unitWeight(l), tw = uw!=null? uw*l.qty : null;
      const amt = l.rate!=null? l.rate*l.qty : null;
      const wMissing = uw==null && l.qty>0;
      const confDot = l.conf==='high' ? '' :
        `<span class="conf-dot conf-${l.conf}" title="AI read confidence: ${l.conf}${l.note?' — '+esc(l.note):''}"></span>`;
      return `<tr data-id="${l.id}" class="${l.status===2?'done':''}">
        <td class="num">${i+1}</td>
        <td><button class="st s${l.status}" data-act="st" title="Click to advance status">${STATUS[l.status]}</button></td>
        <td><span class="desc">${esc(l.desc)}</span><span class="cat-tag cat-${l.cat}">${CAT_LABEL[l.cat]}</span>${confDot}</td>
        <td class="num"><input class="cell" style="width:48px" data-act="dn" value="${l.dn??''}" inputmode="numeric" aria-label="DN"></td>
        <td class="num">${l.pn??'—'}</td>
        <td class="num"><input class="cell" data-act="qty" value="${l.qty}" inputmode="numeric" aria-label="Quantity"></td>
        <td class="num ${wMissing?'wt-missing':''}" title="${wMissing?'No catalogue weight for this line — type it in':''}">
          <input class="cell" style="width:56px" data-act="wt" value="${l.wOv??(uw??'')}" placeholder="?" inputmode="decimal" aria-label="Unit weight kg"></td>
        <td class="num">${tw!=null?fmtKg(tw):'—'}</td>
        <td class="num"><input class="cell" style="width:84px" data-act="rate" value="${l.rate??''}" inputmode="decimal" aria-label="Rate"></td>
        <td class="num">${fmtIN(amt)}</td>
        <td class="num"><input class="cell" style="width:44px" data-act="gst" value="${l.gst??''}" inputmode="numeric" aria-label="GST percent"></td>
        <td style="font-size:11.5px;color:var(--ink-soft)">${esc(l.source)}</td>
        <td><button class="rm" data-act="rm" title="Remove line">×</button></td></tr>`;
    }).join('');
  } else {
    const map = new Map();
    lines.forEach(l=>{
      const key = l.cat+'|'+l.dn+'|'+l.pn;
      if(!map.has(key)) map.set(key,{cat:l.cat,dn:l.dn,pn:l.pn,qty:0,refs:new Set(),sample:l});
      const g = map.get(key); g.qty += l.qty; if(l.source) g.refs.add(l.source);
    });
    const rows = [...map.values()].sort((a,b)=> a.cat.localeCompare(b.cat) || ((a.dn||0)-(b.dn||0)));
    thead.innerHTML = `<tr><th>#</th><th>Product</th><th class="num">DN</th><th class="num">PN</th>
      <th class="num">Total qty</th><th class="num">Wt/pc kg</th><th class="num">Batch kg</th><th>From POs</th></tr>`;
    tbody.innerHTML = rows.map((g,i)=>{
      const uw = unitWeight(g.sample);
      return `<tr><td class="num">${i+1}</td>
        <td><span class="desc">${CATNAME[g.cat]}</span><span class="cat-tag cat-${g.cat}">${CAT_LABEL[g.cat]}</span></td>
        <td class="num">${g.dn??'—'}</td><td class="num">${g.pn??'—'}</td>
        <td class="num"><b>${g.qty}</b></td>
        <td class="num">${fmtKg(uw)}</td>
        <td class="num">${uw!=null?fmtKg(uw*g.qty):'—'}</td>
        <td style="font-size:11.5px;color:var(--ink-soft)">${esc([...g.refs].join(', '))}</td></tr>`;
    }).join('');
  }

  // totals
  let qty=0, basic=0, tax=0, kg=0, kgMissing=0, packedKg=0;
  lines.forEach(l=>{
    qty += l.qty;
    if(l.rate!=null){
      const amt = l.rate*l.qty;
      basic += amt;
      tax += amt * ((l.gst??0)/100);
    }
    const uw = unitWeight(l);
    if(uw!=null){ kg += uw*l.qty; if(l.status===2) packedKg += uw*l.qty; }
    else if(l.qty>0) kgMissing++;
  });

  // additional charges total
  let chargesTotal = 0;
  charges.forEach(c=>{ chargesTotal += (c.amount||0) + (c.tax_amount||0); });
  const trueGrand = basic + tax + chargesTotal;

  $('#kgTotal').innerHTML = `${fmtKg(kg)} <span>kg</span>`;
  const sub = $('#kgSub');
  sub.textContent = kgMissing ? `⚠ ${kgMissing} line(s) missing weight — estimate is LOW` : 'catalogue weights · DN-wise';
  sub.classList.toggle('warn', kgMissing>0);
  $('#stLines').textContent = lines.length;
  $('#stQty').textContent = qty.toLocaleString('en-IN');
  $('#stVal').textContent  = lines.length? '₹ '+fmtIN(basic) : '—';
  $('#stTax').textContent  = lines.length? '₹ '+fmtIN(tax) : '—';

  // Additional charges block
  const chEl = $('#stCharges');
  if(charges.length && lines.length){
    chEl.innerHTML = charges.map(c=>{
      const taxPart = c.tax_amount!=null
        ? `<div class="stat"><span style="padding-left:12px;font-size:11.5px">IGST ${c.tax_percent!=null?c.tax_percent+'% ':''}on above</span><b>₹ ${fmtIN(c.tax_amount)}</b></div>`
        : '';
      return `<div class="stat"><span>${esc(c.desc)}</span><b>₹ ${fmtIN(c.amount)}</b></div>${taxPart}`;
    }).join('');
    chEl.style.display = '';
    $('#stGrand').textContent = '₹ '+fmtIN(trueGrand);
  } else {
    chEl.innerHTML = '';
    chEl.style.display = 'none';
    $('#stGrand').textContent = lines.length? '₹ '+fmtIN(basic+tax) : '—';
  }

  $('#stPacked').textContent = fmtKg(packedKg)+' kg';
  $('#packBar').style.width = kg>0 ? (packedKg/kg*100)+'%' : '0%';
  $('#foot').innerHTML = lines.length?
    `<span>Pieces <b>${qty.toLocaleString('en-IN')}</b></span>
     <span>Est. weight <b>${fmtKg(kg)} kg${kgMissing?' + ?':''}</b></span>
     <span>Basic <b>₹ ${fmtIN(basic)}</b></span>
     <span>GST <b>₹ ${fmtIN(tax)}</b></span>
     <span>Grand total <b>₹ ${fmtIN(basic+tax)}</b></span>` : '';
}

/* ---------- table events ---------- */
tbody.addEventListener('click', e=>{
  const act = e.target.dataset.act; if(!act || act!=='st' && act!=='rm') return;
  const tr = e.target.closest('tr'); const id = +tr?.dataset.id;
  const l = lines.find(x=>x.id===id); if(!l) return;
  if(act==='st'){ l.status=(l.status+1)%3; render(); }
  if(act==='rm'){ lines=lines.filter(x=>x.id!==id); render(); }
});
tbody.addEventListener('change', e=>{
  const act=e.target.dataset.act; if(!act) return;
  const id=+e.target.closest('tr').dataset.id; const l=lines.find(x=>x.id===id); if(!l) return;
  const num = v => { const x=parseFloat(String(v).replace(/[^\d.]/g,'')); return isNaN(x)?null:x; };
  if(act==='qty') l.qty = Math.max(0, Math.round(num(e.target.value)||0));
  if(act==='rate') l.rate = num(e.target.value);
  if(act==='gst')  l.gst  = num(e.target.value) ?? 0;
  if(act==='dn')   l.dn   = num(e.target.value);
  if(act==='wt'){
    const v = num(e.target.value);
    const cat = WEIGHTS[l.cat]?.[l.dn] ?? null;
    l.wOv = (v==null || v===cat) ? null : v;   // storing null = use catalogue
  }
  render();
});

/* ---------- toolbar ---------- */
$('#viewLines').onclick = ()=>{view='lines';$('#viewLines').classList.add('on');$('#viewPlan').classList.remove('on');render();};
$('#viewPlan').onclick  = ()=>{view='plan'; $('#viewPlan').classList.add('on'); $('#viewLines').classList.remove('on');render();};
$('#clearBtn').onclick  = ()=>{  if(lines.length && confirm('Clear all checklist lines and charges?')){lines=[];charges=[];render();} };
$('#printBtn').onclick  = ()=>window.print();

/* ---------- samples (trusted, skip review) ---------- */
document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{
  const s = SAMPLES[c.dataset.sample];
  addLines({ref:s.ref, name:s.name, items:s.items});
  setMsg('ok', `Loaded ${s.items.length} lines from ${s.ref} (${esc(s.name)}).`);
});

/* =====================================================================
   AI extraction — talks to our FastAPI backend, then opens review modal
===================================================================== */
let appKey = null;   // optional X-App-Key, asked for once on 401

async function callBackend(payload){
  const headers = {'Content-Type':'application/json'};
  if(appKey) headers['X-App-Key'] = appKey;
  const res = await fetch('/api/extract', {method:'POST', headers, body:JSON.stringify(payload)});
  if(res.status===401){
    appKey = prompt('This OrderDesk is protected. Enter the app key:');
    if(appKey) return callBackend(payload);
    throw new Error('Unauthorized');
  }
  const data = await res.json().catch(()=>({detail:'Bad response from server'}));
  if(!res.ok) throw new Error(data.detail || ('Server error '+res.status));
  return data;
}

function busy(on, label){
  $('#extractBtn').disabled = on;
  if(on) setMsg('work', `<span class="spinner"></span>${label}`);
}

async function extract(payload, label){
  busy(true, `Reading ${label} with AI…`);
  try{
    const data = await callBackend(payload);
    busy(false);
    if(!data.order || !data.order.items || !data.order.items.length){
      setMsg('err','AI could not find any order lines in that document.'); return;
    }
    openReview(data);
  }catch(err){
    busy(false);
    setMsg('err','Could not read the order: '+esc(err.message));
  }
}

async function fileToPart(file){
  const b64 = await new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>res(r.result.split(',')[1]);
    r.onerror=()=>rej(new Error('Could not read '+file.name));
    r.readAsDataURL(file);
  });
  const mt = /\.pdf$/i.test(file.name) ? 'application/pdf' : (file.type||'image/jpeg');
  return {media_type:mt, data:b64};
}

/* intake wiring */
const dz=$('#dz'), fileIn=$('#fileIn');
dz.onclick=()=>fileIn.click();
dz.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fileIn.click();}};
async function handleFiles(list){
  const files=[...list]; if(!files.length) return;
  const txt = files.filter(f=>/\.txt$/i.test(f.name));
  const docs = files.filter(f=>!/\.txt$/i.test(f.name));
  const payload = {files:[], text:null};
  for(const f of docs) payload.files.push(await fileToPart(f));
  if(txt.length) payload.text = (await Promise.all(txt.map(f=>f.text()))).join('\n\n');
  extract(payload, files.length===1?files[0].name:files.length+' files');
}
fileIn.onchange=()=>{ handleFiles(fileIn.files); fileIn.value=''; };
['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('on');}));
['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('on');}));
dz.addEventListener('drop',e=>handleFiles(e.dataTransfer.files));
$('#extractBtn').onclick=()=>{
  const t=$('#pasteIn').value.trim();
  if(!t){ setMsg('err','Paste some order text first, or drop a file above.'); return; }
  extract({text:t, files:[]}, 'pasted order');
};

/* =====================================================================
   Review modal — the quality gate
===================================================================== */
const overlay=$('#overlay');

function openReview(data){
  pending = data;
  const o = data.order, v = data.verification;
  const badge = $('#rvBadge');
  if(v.reconciled && !v.low_confidence_lines.length){
    badge.className='badge ok'; badge.textContent='✓ Figures reconcile';
    $('#rvHint').textContent='All arithmetic checks pass. Review and add.';
  } else if(v.reconciled){
    badge.className='badge warn'; badge.textContent='Reconciled · review flagged lines';
    $('#rvHint').textContent='Totals reconcile, but some lines were hard to read — check the highlighted ones.';
  } else {
    badge.className='badge warn'; badge.textContent='⚠ Mismatch — verify against document';
    $('#rvHint').textContent='The numbers do not reconcile with the document totals. Verify before adding.';
  }
  $('#rvMeta').textContent = `${o.quality||'?'} · ${data.meta?.passes||1} pass${(data.meta?.passes||1)>1?'es':''} · ${data.meta?.model||''}`;

  const taxTxt = o.tax && o.tax.rate_percent!=null
    ? (o.tax.kind==='cgst_sgst' ? `CGST+SGST ${o.tax.rate_percent}%` :
       o.tax.kind==='igst' ? `IGST ${o.tax.rate_percent}%` : `${o.tax.rate_percent}%`)
    : '—';
  const st=o.stated_totals||{};
  const charges = o.additional_charges||[];
  const chargesHtml = charges.length ? charges.map(ac=>
    `<div><div class="k">${esc(ac.description)}${ac.tax_percent!=null?' + '+ac.tax_percent+'% tax':''}</div>₹ ${fmtIN(ac.amount)}${ac.tax_amount!=null?' + ₹ '+fmtIN(ac.tax_amount)+' tax':''}</div>`
  ).join('') : '';
  const roundHtml = st.rounding_off!=null ? `<div><div class="k">Rounding off</div>₹ ${st.rounding_off>=0?'+':''}${st.rounding_off}</div>` : '';
  $('#rvHead').innerHTML = `
    <div><div class="k">Customer</div>${esc(o.customer||'—')}</div>
    <div><div class="k">PO ref</div>${esc(o.po_ref||'—')}</div>
    <div><div class="k">Date</div>${esc(o.po_date||'—')}</div>
    <div><div class="k">Tax on document</div>${taxTxt}</div>
    <div><div class="k">Doc basic / grand</div>${st.basic_value!=null?'₹ '+fmtIN(st.basic_value):'—'} / ${st.grand_total!=null?'₹ '+fmtIN(st.grand_total):'—'}</div>
    ${chargesHtml}${roundHtml}
    <div style="grid-column:1/-1"><div class="k">Terms</div>${esc(o.terms||'—')}</div>`;

  $('#rvChecks').innerHTML = (v.checks||[]).map(c=>{
    const ic = c.level==='ok'?'✓':c.level==='warn'?'⚠':'·';
    return `<div class="c ${c.level}"><span class="ic">${ic}</span><span><b style="font-weight:600">${esc(c.check)}:</b> ${esc(c.detail)}</span></div>`;
  }).join('') || '<div class="c info"><span class="ic">·</span>No checks available.</div>';

  $('#rvTbl tbody').innerHTML = o.items.map((it,i)=>{
    const cls = it.confidence==='low'?'low':it.confidence==='medium'?'medium':'';
    return `<tr class="${cls}">
      <td class="num">${it.sno??i+1}</td>
      <td>${esc(it.description)}${it.note?`<div class="linenote">⚠ ${esc(it.note)}</div>`:''}</td>
      <td class="num">${it.dn??parseDN(it.description)??'—'}</td>
      <td class="num">${it.pn??'—'}</td>
      <td class="num">${it.qty}</td>
      <td class="num">${fmtIN(it.rate)}</td>
      <td class="num">${fmtIN(it.amount)}</td>
      <td class="num">${it.gst_percent??(o.tax?.rate_percent??'—')}</td>
      <td style="font-size:11px;color:var(--ink-soft)">${it.confidence}</td></tr>`;
  }).join('');

  overlay.classList.add('show');
  $('#rvAdd').focus();
}
function closeReview(){
  overlay.classList.remove('show');
  pending = null;
  busy(false);                          // re-enable Extract button, clear spinner
  msg.classList.remove('show');         // clear any lingering status message
}
$('#rvDiscard').onclick = closeReview;
overlay.addEventListener('click', e=>{ if(e.target===overlay) closeReview(); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && overlay.classList.contains('show')) closeReview(); });
$('#rvAdd').onclick = ()=>{
  if(!pending) return;
  const o = pending.order;
  addLines({ref:o.po_ref||'', name:o.customer||'', gst:o.tax?.rate_percent, items:o.items});

  // Merge additional charges (supply charges, freight, etc.)
  (o.additional_charges||[]).forEach(ac=>{
    if(!ac.amount) return;
    const dup = charges.some(c=>c.desc===ac.description && c.amount===ac.amount);
    if(!dup) charges.push({desc:ac.description, amount:ac.amount,
      tax_percent:ac.tax_percent, tax_amount:ac.tax_amount});
  });

  setMsg('ok', `Added ${o.items.length} lines from ${esc(o.po_ref||o.customer||'order')}.` +
    (pending.verification.reconciled ? ' Figures reconciled ✓' : ' ⚠ Check flagged lines in the table.'));
  closeReview();
};

/* =====================================================================
   Excel export
===================================================================== */
$('#xlsxBtn').onclick=()=>{
  if(!lines.length){ setMsg('err','Nothing to export yet — add some order lines first.'); return; }
  const wb = XLSX.utils.book_new();

  const rows1 = [['S.NO','Description','DN','PN','QTY','Unit Wt (kg)','Total Wt (kg)',
                  'Rate','Amount','GST %','GST Amt','Line Total','Status','PO Ref']];
  let qtyS=0,kgS=0,basS=0,taxS=0;
  lines.forEach((l,i)=>{
    const uw=unitWeight(l); const amt=l.rate!=null?l.rate*l.qty:null;
    const gAmt=amt!=null?amt*((l.gst??0)/100):null;
    qtyS+=l.qty; if(uw!=null)kgS+=uw*l.qty; if(amt!=null){basS+=amt;taxS+=gAmt;}
    rows1.push([i+1,l.desc,l.dn??'',l.pn??'',l.qty,
      uw??'', uw!=null?+(uw*l.qty).toFixed(1):'',
      l.rate??'', amt!=null?+amt.toFixed(2):'',
      l.gst??'', gAmt!=null?+gAmt.toFixed(2):'', amt!=null?+(amt+gAmt).toFixed(2):'',
      STATUS[l.status], l.source]);
  });
  rows1.push([]);
  rows1.push(['','TOTAL','','',qtyS,'',+kgS.toFixed(1),'',+basS.toFixed(2),'',
              +taxS.toFixed(2),+(basS+taxS).toFixed(2),'','']);
  const ws1=XLSX.utils.aoa_to_sheet(rows1);
  ws1['!cols']=[{wch:5},{wch:46},{wch:6},{wch:5},{wch:7},{wch:11},{wch:12},{wch:11},
                {wch:13},{wch:7},{wch:12},{wch:13},{wch:13},{wch:20}];
  XLSX.utils.book_append_sheet(wb,ws1,'Checklist');

  const map=new Map();
  lines.forEach(l=>{const k=l.cat+'|'+l.dn+'|'+l.pn;
    if(!map.has(k))map.set(k,{cat:l.cat,dn:l.dn,pn:l.pn,qty:0,sample:l});
    map.get(k).qty+=l.qty;});
  const rows2=[['#','Product','DN','PN','Total Qty','Unit Wt (kg)','Batch Wt (kg)']];
  [...map.values()].sort((a,b)=>a.cat.localeCompare(b.cat)||((a.dn||0)-(b.dn||0))).forEach((g,i)=>{
    const uw=unitWeight(g.sample);
    rows2.push([i+1,CATNAME[g.cat],g.dn??'',g.pn??'',g.qty,uw??'',uw!=null?+(uw*g.qty).toFixed(1):'']);
  });
  const ws2=XLSX.utils.aoa_to_sheet(rows2);
  ws2['!cols']=[{wch:4},{wch:34},{wch:6},{wch:5},{wch:10},{wch:11},{wch:13}];
  XLSX.utils.book_append_sheet(wb,ws2,'Production plan');

  XLSX.writeFile(wb,'STS_production_checklist.xlsx');
  setMsg('ok','Excel exported — Checklist + Production plan sheets, GST included.');
};

render();
