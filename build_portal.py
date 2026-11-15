#!/usr/bin/env python3
"""Generate the Builder Buy Box Portal as a single static index.html
from the portal dataset extracted via the artifact's getportal action."""
import json, pathlib

SRC = pathlib.Path.home() / "workspace/agents/d65f8ee5-934e-42c7-9fd2-d5b9aa0e9f9b/tool-output/artifact.invoke_action-call_01a1dc89ce8c75c2a1330f9ab0997c49.json"
OUT = pathlib.Path.home() / "workspace/wholesale-ai/index.html"

raw = json.loads(SRC.read_text())
data = raw["data"]
payload = {
    "pockets": data["pockets"],
    "builders": data["builders"],
    "lastRefreshedAt": data.get("lastRefreshedAt"),
    "lastRefreshSummary": data.get("lastRefreshSummary"),
}
# Estimated price per acre from dirt purchases in the past 12 months
# (Nov 14, 2025 - Nov 14, 2026) where BOTH a recorded price and a lot size
# are on file. Builders not listed here have no such purchase on record and
# render as an em dash - never estimated from exit prices.
PPA = {
    "2K Development + Superior Capital": (
        "$0.49M–$1.35M",
        "Price per acre from 7 dirt purchases, Nov 2025–Sep 2026 (Davidson County deed records): "
        "$490K/acre (6324 Jocelyn Hollow Rd, $1,000,000 on 2.04 ac) to $1,354K/acre (709 Vosswod Dr, $1,300,000 on 0.96 ac)."),
    "MJH Ventures": (
        "≈$1.01M",
        "Single purchase in window: 764 Darden Pl, $1,657,500 on 1.64 ac (demo permit issued Nov 11, 2026)."),
    "KEDEM": (
        "≈$2.77M",
        "Single purchase in window: 5530 Willow Ln, ~$1,070,000 paid (operator-corrected figure; last list was $1,300,000) "
        "on 0.386 ac, sold Dec 2025. Texas is non-disclosure; priced on the corrected paid figure."),
    "Park Avenue Capital Group": (
        "—",
        "No priced dirt purchase inside the past 12 months. Nearest: 6014 Boca Raton Dr dirt at $1,450,000 last list on 0.39 ac "
        "(≈$3.72M/acre), confirmed sale Sep 29, 2025 - just outside the window."),
    "Elliott Homes": (
        "—",
        "No priced dirt purchase inside the past 12 months. Benham Ave dirt ($2,000,000 on 0.44 ac, ≈$4.55M/acre) was Jul 2025, outside the window."),
    "Southern Spaces": (
        "—",
        "No priced dirt purchase inside the past 12 months. 611 W Meade Dr dirt was $1,075,000 in Mar 2025 on a 1.12-ac lot (≈$0.96M/acre), outside the window."),
    "800 Builders LLC": (
        "—",
        "HCAD records no sale prices; its two Wickford Dr lots carry assessed land values of $1.68M–$1.84M on 30,000+ SF lots, "
        "which is not a paid price, so no per-acre figure is stated."),
}
for b in payload["builders"]:
    v = PPA.get(b["name"])
    b["ppa"] = v[0] if v else "—"
    b["ppaBasis"] = v[1] if v else None

blob = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")

html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Builder Buy Box Portal — Coconut Property Ventures</title>
<style>
  :root{--ink:#1a2332;--mut:#5b6b82;--line:#d9e0ea;--bg:#f6f8fa;--card:#fff;--acc:#0f5c3f;--accbg:#e6f4ec;--warn:#8a5a00;--warnbg:#fdf3e0}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink)}
  header{background:#10231b;color:#fff;padding:26px 20px 20px}
  header h1{margin:0 0 6px;font-size:26px}
  header p{margin:2px 0;color:#c8d8cf;font-size:14px}
  .wrap{max-width:1180px;margin:0 auto;padding:18px 16px 60px}
  .controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0 6px}
  .controls input[type=search]{flex:1;min-width:220px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:15px}
  .chip{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:8px 14px;cursor:pointer;font-size:14px}
  .chip.on{background:var(--acc);color:#fff;border-color:var(--acc)}
  .chk{display:flex;gap:7px;align-items:center;font-size:14px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;cursor:pointer}
  .stats{color:var(--mut);font-size:13px;margin:8px 2px 0}
  section.pocket{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:18px 0;padding:16px 16px 8px}
  section.pocket h2{margin:0;font-size:20px}
  .meta{color:var(--mut);font-size:13px;margin:4px 0 2px}
  .dirt{font-size:13.5px;margin:6px 0}
  .note{font-size:13.5px;background:var(--warnbg);color:var(--warn);border-radius:8px;padding:8px 10px;margin:8px 0}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{text-align:left;vertical-align:top;padding:9px 8px;border-top:1px solid var(--line);font-size:14px}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);border-top:none}
  .bname{font-weight:600}
  .sub{color:var(--mut);font-size:12.5px}
  .badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.03em;border-radius:4px;padding:2px 6px;margin-left:6px;vertical-align:middle}
  .badge.stated{background:var(--accbg);color:var(--acc)}
  .badge.revealed{background:#e8edf5;color:#33507e}
  .yes{font-weight:700;color:var(--acc)}
  .no{color:var(--mut)}
  td a{color:var(--acc);text-decoration:none;word-break:break-all}
  .det{cursor:pointer;color:var(--acc);font-size:13px;white-space:nowrap}
  .detail td{background:#fafbfc;font-size:13.5px;color:#33404f}
  .detail p{margin:4px 0}
  .empty{color:var(--mut);font-size:14px;padding:10px 2px 14px}
  footer{color:var(--mut);font-size:12.5px;max-width:1180px;margin:0 auto;padding:0 16px 40px}
  @media (max-width:760px){
    table,thead,tbody,tr,th,td{display:block}
    thead{display:none}
    tr{border-top:1px solid var(--line);padding:6px 0}
    td{border-top:none;padding:4px 8px}
    td.lbl::before{content:attr(data-l) ": ";font-weight:600;color:var(--mut);font-size:12px;text-transform:uppercase}
  }
</style>
</head>
<body>
<header>
  <div class="wrap" style="padding:0">
    <h1>Builder Buy Box Portal</h1>
    <p>Coconut Property Ventures LLC — builders who built $2.5M+ teardown properties in the past 12 months, by pocket.</p>
    <p id="refreshed"></p>
  </div>
</header>
<div class="wrap">
  <div class="controls">
    <input type="search" id="q" placeholder="Search builders, pockets, streets, contacts...">
    <span id="chips"></span>
    <label class="chk"><input type="checkbox" id="yesOnly"> Built $2.5M+ in past 3 months only</label>
  </div>
  <div class="stats" id="stats"></div>
  <div id="app"></div>
</div>
<footer>
  <b>Est. price per acre</b> is computed only from a builder's dirt purchases in the past 12 months where both a recorded price and a lot size are on file; it is never derived from exit prices. An em dash means no such purchase is on record.
  Buy boxes are labeled <b>Stated</b> (published or given by the builder) or <b>Revealed</b> (derived from verified purchases, listings, and sales).
  Contacts are shown only where publicly verified. Texas is a non-disclosure state; TX sold prices are MLS last-list approximations.
  Data re-verified monthly (1st weekday, 9am ET) and whenever a builder changes their buy box.
</footer>
<script>
const DATA = __BLOB__;
const MARKETS = ["Nashville, TN","Dallas, TX","Houston, TX","West Palm Beach, FL"];
let market = "All", yesOnly = false, q = "";
const byId = {}; DATA.pockets.forEach(p=>byId[p.id]=p);
const bByPocket = {};
DATA.builders.forEach(b=>{(b.pocketIds||[]).forEach(pid=>{(bByPocket[pid]=bByPocket[pid]||[]).push(b)})});
const chipsEl = document.getElementById('chips');
["All",...MARKETS].forEach(m=>{
  const c=document.createElement('button');c.className='chip'+(m==="All"?' on':'');c.textContent=m.replace(', TN','').replace(', TX','').replace(', FL','');
  c.onclick=()=>{market=m;document.querySelectorAll('.chip').forEach(x=>x.classList.remove('on'));c.classList.add('on');render()};
  chipsEl.appendChild(c);
});
document.getElementById('q').addEventListener('input',e=>{q=e.target.value.toLowerCase();render()});
document.getElementById('yesOnly').addEventListener('change',e=>{yesOnly=e.target.checked;render()});
document.getElementById('refreshed').textContent = "Data as of " + new Date(DATA.lastRefreshedAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) + " · " + DATA.pockets.length + " pockets · " + DATA.builders.length + " builders";
function match(b,p){
  if(yesOnly && !b.built3mo) return false;
  if(!q) return true;
  const hay=[b.name,b.principal,b.tier,b.boxText,b.exitBand,(b.emails||[]).join(' '),(b.phones||[]).join(' '),p.name,p.market].join(' ').toLowerCase();
  return hay.includes(q);
}
function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}
function render(){
  const app=document.getElementById('app');app.innerHTML='';let shown=0;
  MARKETS.forEach(mk=>{
    if(market!=="All"&&market!==mk) return;
    DATA.pockets.filter(p=>p.market===mk).forEach(p=>{
      const bs=(bByPocket[p.id]||[]).filter(b=>match(b,p));
      if(q&&bs.length===0) return;
      shown+=bs.length;
      const s=document.createElement('section');s.className='pocket';
      let h=`<h2>${esc(p.name)}</h2><div class="meta">${esc(p.market)} · ZIP ${p.zips.map(esc).join(', ')}</div>`;
      if(p.dirtBand) h+=`<div class="dirt"><b>Dirt band:</b> ${esc(p.dirtBand)}</div>`;
      if(p.pocketNote) h+=`<div class="note">${esc(p.pocketNote)}</div>`;
      if(bs.length===0){h+=`<div class="empty">No builder with a verified $2.5M+ build on file for this pocket yet.</div>`}
      else{
        h+=`<table><thead><tr><th>Builder</th><th>Buy box</th><th>Exit band</th><th>Est. price per acre (dirt, past 12 mo)</th><th>Email</th><th>Phone</th><th>Built any $2.5M+ within past 3 months</th><th></th></tr></thead><tbody>`;
        bs.forEach((b,i)=>{
          const badge=`<span class="badge ${b.boxType}">${b.boxType==='stated'?'STATED':'REVEALED'}</span>`;
          h+=`<tr>
            <td><span class="bname">${esc(b.name)}</span>${b.principal?`<div class="sub">${esc(b.principal)}</div>`:''}${b.tier?`<div class="sub">${esc(b.tier)}</div>`:''}</td>
            <td>${esc(b.boxText)}${badge}</td>
            <td>${esc(b.exitBand||'')}</td>
            <td>${b.ppa&&b.ppa!=='—'?`<b>${esc(b.ppa)}</b>`:'<span class="sub">—</span>'}</td>
            <td>${(b.emails||[]).map(e=>`<a href="mailto:${esc(e)}">${esc(e)}</a>`).join('<br>')||'<span class="sub">Not on file</span>'}</td>
            <td>${(b.phones||[]).map(e=>esc(e)).join('<br>')||'<span class="sub">Not on file</span>'}</td>
            <td class="${b.built3mo?'yes':'no'}">${b.built3mo?'Yes':'No'}</td>
            <td><span class="det" data-p="${p.id}" data-i="${i}">Evidence</span></td></tr>
          <tr class="detail" id="d-${p.id}-${i}" style="display:none"><td colspan="8">
            ${b.ppaBasis?`<p><b>Price per acre basis:</b> ${esc(b.ppaBasis)}</p>`:`<p><b>Price per acre basis:</b> No dirt purchase in the past 12 months with both a recorded price and a lot size on file for this builder.</p>`}
            ${b.evidence?`<p><b>Evidence:</b> ${esc(b.evidence)}</p>`:''}
            ${b.built3moEvidence?`<p><b>Past-3-months basis:</b> ${esc(b.built3moEvidence)}</p>`:''}
            ${b.contactNote?`<p><b>Contact note:</b> ${esc(b.contactNote)}</p>`:''}
            ${b.sourceNote?`<p><b>Source:</b> ${esc(b.sourceNote)}</p>`:''}
          </td></tr>`;
        });
        h+='</tbody></table>';
      }
      s.innerHTML=h;app.appendChild(s);
    });
  });
  document.getElementById('stats').textContent = shown + ' builder rows shown';
  app.querySelectorAll('.det').forEach(el=>el.onclick=()=>{
    const row=document.getElementById(`d-${el.dataset.p}-${el.dataset.i}`);
    row.style.display=row.style.display==='none'?'':'none';
  });
}
render();
</script>
</body>
</html>
"""

OUT.write_text(html.replace("__BLOB__", blob))
print("wrote", OUT, len(OUT.read_text()), "bytes;", len(data["builders"]), "builders;", len(data["pockets"]), "pockets")
