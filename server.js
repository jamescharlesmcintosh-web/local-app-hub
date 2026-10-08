
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { exec } = require("child_process");

const HOST = "127.0.0.1";
const PORT = 8787;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "app-hub-data.json");
const PID_FILE = path.join(ROOT, "hub.pid");
const processes = new Map();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}
function getData() {
  const data = readJson(DATA_FILE, { projects: [], extraRoots: [] });
  data.projects = Array.isArray(data.projects) ? data.projects : [];
  data.extraRoots = Array.isArray(data.extraRoots) ? data.extraRoots : [];
  return data;
}
function saveData(data) { writeJson(DATA_FILE, data); }

function normalize(p) {
  try { return path.resolve(String(p).replace(/^"(.*)"$/, "$1")); } catch { return String(p); }
}
function isInsideNodeModules(p) {
  return p.split(path.sep).some(x => x.toLowerCase() === "node_modules");
}
function detectFramework(pkg, dir) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps["next"]) return "Next.js";
  if (deps["vite"]) return "Vite";
  if (deps["react-scripts"]) return "Create React App";
  if (deps["@remix-run/dev"]) return "Remix";
  if (deps["astro"]) return "Astro";
  if (deps["nuxt"]) return "Nuxt";
  if (deps["@angular/core"]) return "Angular";
  if (deps["svelte"] || deps["@sveltejs/kit"]) return "Svelte";
  if (fs.existsSync(path.join(dir, "vite.config.js")) || fs.existsSync(path.join(dir, "vite.config.ts"))) return "Vite";
  return "Node web app";
}
function chooseScript(pkg) {
  const scripts = pkg.scripts || {};
  for (const k of ["dev", "start", "serve", "preview"]) if (scripts[k]) return k;
  return null;
}
function inferPortFromScript(scriptText) {
  if (!scriptText) return null;
  const patterns = [
    /--port(?:=|\s+)(\d{2,5})/i,
    /-p(?:=|\s+)(\d{2,5})/i,
    /PORT\s*=\s*(\d{2,5})/i,
    /localhost:(\d{2,5})/i
  ];
  for (const re of patterns) {
    const m = scriptText.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}
function projectFromDir(dir) {
  const packagePath = path.join(dir, "package.json");
  if (!fs.existsSync(packagePath)) return null;
  const pkg = readJson(packagePath, null);
  if (!pkg) return null;
  const script = chooseScript(pkg);
  if (!script) return null;
  const scriptText = (pkg.scripts || {})[script] || "";
  const inferredPort = inferPortFromScript(scriptText);
  return {
    id: Buffer.from(dir).toString("base64url"),
    name: pkg.name || path.basename(dir),
    path: dir,
    framework: detectFramework(pkg, dir),
    script,
    command: `npm run ${script}`,
    lastUrl: inferredPort ? `http://localhost:${inferredPort}` : null,
    pinned: false,
    discoveredAt: new Date().toISOString()
  };
}

function walkForProjects(rootDir, maxDepth=5) {
  const found = [];
  const seen = new Set();
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let stat;
    try { stat = fs.statSync(dir); } catch { return; }
    if (!stat.isDirectory() || isInsideNodeModules(dir)) return;
    const base = path.basename(dir).toLowerCase();
    if ([".git",".next","dist","build","out","coverage",".vercel",".cache"].includes(base)) return;

    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) {
      const proj = projectFromDir(dir);
      if (proj && !seen.has(proj.path.toLowerCase())) {
        found.push(proj);
        seen.add(proj.path.toLowerCase());
      }
      // Still descend one level because monorepos can contain apps.
    }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const n = ent.name.toLowerCase();
      if (["node_modules",".git",".next","dist","build","out","coverage",".vercel",".cache"].includes(n)) continue;
      walk(path.join(dir, ent.name), depth + 1);
    }
  }
  walk(rootDir, 0);
  return found;
}

function defaultRoots() {
  const home = os.homedir();
  const roots = [
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Downloads"),
    path.join(home, "OneDrive", "Desktop"),
    path.join(home, "OneDrive", "Documents"),
    path.join(home, "source", "repos"),
    path.dirname(ROOT)
  ];
  return [...new Set(roots.map(normalize))].filter(p => {
    try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
  });
}
function mergeProjects(existing, discovered) {
  const byPath = new Map(existing.map(p => [normalize(p.path).toLowerCase(), p]));
  for (const p of discovered) {
    const key = normalize(p.path).toLowerCase();
    if (byPath.has(key)) {
      const old = byPath.get(key);
      byPath.set(key, { ...p, pinned: !!old.pinned, lastUrl: old.lastUrl || p.lastUrl, customName: old.customName });
    } else byPath.set(key, p);
  }
  return [...byPath.values()].sort((a,b) => (b.pinned-a.pinned) || (displayName(a).localeCompare(displayName(b))));
}
function displayName(p) { return p.customName || p.name || path.basename(p.path); }

async function rescan() {
  const data = getData();
  const roots = [...defaultRoots(), ...data.extraRoots.map(normalize)]
    .filter((v,i,a) => a.indexOf(v) === i)
    .filter(p => { try { return fs.existsSync(p); } catch { return false; }});
  let discovered = [];
  for (const r of roots) discovered = discovered.concat(walkForProjects(r, 5));
  data.projects = mergeProjects(data.projects, discovered);
  saveData(data);
  return { count: data.projects.length, roots };
}

function runtimeInfo(project) {
  const proc = processes.get(project.id);
  return {
    running: !!proc && !proc.child.killed,
    url: proc?.url || project.lastUrl || null,
    startedAt: proc?.startedAt || null,
    logTail: proc?.logTail?.slice(-20) || []
  };
}
function listProjects() {
  const data = getData();
  return data.projects.map(p => ({...p, displayName: displayName(p), runtime: runtimeInfo(p)}));
}

function startProject(project) {
  if (processes.has(project.id) && !processes.get(project.id).child.killed) return processes.get(project.id);
  const child = spawn("cmd.exe", ["/d", "/s", "/c", `npm run ${project.script}`], {
    cwd: project.path,
    windowsHide: true,
    env: { ...process.env, BROWSER: "none" }
  });
  const rec = { child, url: project.lastUrl || null, startedAt: new Date().toISOString(), logTail: [] };
  processes.set(project.id, rec);

  const onData = (buf) => {
    const text = String(buf);
    rec.logTail.push(...text.split(/\r?\n/).filter(Boolean));
    rec.logTail = rec.logTail.slice(-50);
    const matches = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?/ig);
    if (matches && matches.length) {
      rec.url = matches[matches.length - 1].replace("127.0.0.1", "localhost");
      const data = getData();
      const p = data.projects.find(x => x.id === project.id);
      if (p) { p.lastUrl = rec.url; saveData(data); }
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("exit", code => {
    rec.logTail.push(`Process exited with code ${code}`);
    setTimeout(() => processes.delete(project.id), 5000);
  });
  return rec;
}

function stopProject(project) {
  const rec = processes.get(project.id);
  if (!rec) return false;
  try {
    exec(`taskkill /PID ${rec.child.pid} /T /F`, () => {});
  } catch {}
  processes.delete(project.id);
  return true;
}
function openUrl(url) {
  if (!url) return;
  exec(`start "" "${String(url).replace(/"/g, "")}"`);
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)});
  res.end(body);
}
function readBody(req) {
  return new Promise(resolve => {
    let s = "";
    req.on("data", d => s += d);
    req.on("end", () => {
      try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); }
    });
  });
}
function html() {
return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local App Hub</title>
<style>
:root{color-scheme:dark;--bg:#090b10;--panel:#11151d;--line:#232a36;--muted:#8d98aa;--text:#eef3fb;--accent:#7ee787;--blue:#79c0ff;--danger:#ff7b72}
*{box-sizing:border-box} body{margin:0;font:14px/1.45 Inter,ui-sans-serif,system-ui,Segoe UI,Arial;background:radial-gradient(circle at 20% 0,#162132 0,transparent 34%),var(--bg);color:var(--text)}
header{position:sticky;top:0;z-index:3;padding:18px 22px;border-bottom:1px solid var(--line);background:rgba(9,11,16,.88);backdrop-filter:blur(18px)}
.top{display:flex;gap:12px;align-items:center;justify-content:space-between;max-width:1280px;margin:auto}
h1{font-size:20px;margin:0}.sub{color:var(--muted);font-size:12px;margin-top:3px}
.actions{display:flex;gap:8px;flex-wrap:wrap}
button,input{font:inherit}button{border:1px solid var(--line);background:#161b24;color:var(--text);padding:9px 12px;border-radius:10px;cursor:pointer}
button:hover{border-color:#46536a}.primary{background:#17351f;border-color:#2d6c3a}.danger{color:#ffb4ae}
main{max-width:1280px;margin:auto;padding:22px}
.toolbar{display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:18px}
input{width:100%;background:#0d1117;border:1px solid var(--line);color:var(--text);padding:11px 12px;border-radius:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
.card{border:1px solid var(--line);background:linear-gradient(180deg,#111721,#0e1219);border-radius:16px;padding:16px;min-height:184px;display:flex;flex-direction:column;gap:10px}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.name{font-size:16px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:11px;color:var(--blue);border:1px solid #28425d;background:#0e2032;padding:3px 7px;border-radius:999px;white-space:nowrap}
.path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status{font-size:12px;color:var(--muted)}.running{color:var(--accent)}.buttons{display:flex;gap:7px;flex-wrap:wrap;margin-top:auto}
.buttons button{padding:8px 10px}.url{font-size:12px;color:#a8c7fa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{padding:40px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:16px}
details{font-size:12px;color:var(--muted)}pre{white-space:pre-wrap;max-height:150px;overflow:auto;background:#090c11;padding:8px;border-radius:8px;border:1px solid var(--line)}
#toast{position:fixed;right:18px;bottom:18px;background:#161b24;border:1px solid var(--line);padding:10px 13px;border-radius:10px;display:none}
@media(max-width:680px){.top{align-items:flex-start;flex-direction:column}.toolbar{grid-template-columns:1fr}.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><div class="top"><div><h1>LOCAL APP HUB</h1><div class="sub">Your localhost projects in one place · hub runs at localhost:${PORT}</div></div><div class="actions"><button onclick="rescan()">↻ Rescan</button><button onclick="shutdown()" class="danger">Stop Hub</button></div></div></header>
<main>
<div class="toolbar">
  <input id="filter" placeholder="Filter apps by name, framework, or path…" oninput="render()">
  <button class="primary" onclick="addProject()">+ Add project path</button>
</div>
<div id="grid" class="grid"></div>
</main>
<div id="toast"></div>
<script>
let projects=[];
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#039;"}[m]));
function toast(t){const el=document.getElementById("toast");el.textContent=t;el.style.display="block";setTimeout(()=>el.style.display="none",2200)}
async function api(url, body){const r=await fetch(url,{method:body?"POST":"GET",headers:{"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});return r.json()}
async function load(){projects=await api("/api/projects");render()}
function render(){
 const q=document.getElementById("filter").value.toLowerCase();
 const list=projects.filter(p=>[p.displayName,p.framework,p.path].join(" ").toLowerCase().includes(q));
 const grid=document.getElementById("grid");
 if(!list.length){grid.innerHTML='<div class="empty">No projects found. Click <b>Rescan</b> or <b>Add project path</b>.</div>';return}
 grid.innerHTML=list.map(p=>{
  const rt=p.runtime||{}; const running=!!rt.running; const url=rt.url||"";
  return '<div class="card">'+
   '<div class="row"><div class="name" title="'+esc(p.displayName)+'">'+esc(p.displayName)+'</div><span class="badge">'+esc(p.framework)+'</span></div>'+
   '<div class="path" title="'+esc(p.path)+'">'+esc(p.path)+'</div>'+
   '<div class="status '+(running?'running':'')+'">'+(running?'● Running':'○ Stopped')+' · '+esc(p.command)+'</div>'+
   '<div class="url">'+(url?esc(url):'URL will appear after the dev server reports it')+'</div>'+
   '<div class="buttons">'+
    '<button class="primary" onclick="startApp(\\''+p.id+'\\')">▶ Start</button>'+
    '<button onclick="openApp(\\''+p.id+'\\')" '+(!url?'disabled':'')+'>↗ Open</button>'+
    '<button onclick="stopApp(\\''+p.id+'\\')">■ Stop</button>'+
    '<button onclick="togglePin(\\''+p.id+'\\')">'+(p.pinned?'★':'☆')+'</button>'+
    '<button class="danger" onclick="removeApp(\\''+p.id+'\\')">Remove</button>'+
   '</div>'+
   ((rt.logTail&&rt.logTail.length)?'<details><summary>Recent log</summary><pre>'+esc(rt.logTail.join("\\n"))+'</pre></details>':'')+
  '</div>'
 }).join("");
}
async function rescan(){toast("Scanning your common project folders…");const r=await api("/api/rescan",{});toast("Found "+r.count+" projects");await load()}
async function addProject(){const p=prompt("Paste the project folder path (the folder containing package.json):");if(!p)return;const r=await api("/api/add",{path:p});if(r.error)toast(r.error);else{toast("Project added");await load()}}
async function startApp(id){toast("Starting app…");const r=await api("/api/start",{id});if(r.error)toast(r.error);setTimeout(load,700);setTimeout(load,2200)}
async function stopApp(id){await api("/api/stop",{id});toast("Stopped");await load()}
async function openApp(id){const r=await api("/api/open",{id});if(r.error)toast(r.error)}
async function togglePin(id){await api("/api/pin",{id});await load()}
async function removeApp(id){await api("/api/remove",{id});await load()}
async function shutdown(){if(confirm("Stop the Local App Hub?")){await api("/api/shutdown",{});document.body.innerHTML='<main><div class="empty">Local App Hub stopped. Double-click START_LOCAL_APP_HUB.bat to open it again.</div></main>'}}
load(); setInterval(load,2500);
</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === "GET" && u.pathname === "/") {
    const body = html();
    res.writeHead(200, {"Content-Type":"text/html; charset=utf-8","Content-Length":Buffer.byteLength(body)});
    return res.end(body);
  }
  if (req.method === "GET" && u.pathname === "/api/projects") return sendJson(res, 200, listProjects());
  if (req.method === "POST" && u.pathname === "/api/rescan") return sendJson(res, 200, await rescan());

  if (req.method === "POST") {
    const body = await readBody(req);
    const data = getData();
    const project = data.projects.find(p => p.id === body.id);

    if (u.pathname === "/api/add") {
      const dir = normalize(body.path || "");
      const proj = projectFromDir(dir);
      if (!proj) return sendJson(res, 400, {error:"That folder does not look like a runnable Node web app with package.json and a dev/start/serve/preview script."});
      data.projects = mergeProjects(data.projects, [proj]);
      if (!data.extraRoots.includes(dir)) data.extraRoots.push(dir);
      saveData(data);
      return sendJson(res, 200, {ok:true});
    }
    if (!project && ["/api/start","/api/stop","/api/open","/api/pin","/api/remove"].includes(u.pathname))
      return sendJson(res, 404, {error:"Project not found"});

    if (u.pathname === "/api/start") { startProject(project); return sendJson(res, 200, {ok:true}); }
    if (u.pathname === "/api/stop") { stopProject(project); return sendJson(res, 200, {ok:true}); }
    if (u.pathname === "/api/open") {
      const url = runtimeInfo(project).url;
      if (!url) return sendJson(res, 400, {error:"No localhost URL detected yet. Start the app and wait a moment."});
      openUrl(url); return sendJson(res, 200, {ok:true});
    }
    if (u.pathname === "/api/pin") {
      project.pinned = !project.pinned; saveData(data); return sendJson(res, 200, {ok:true});
    }
    if (u.pathname === "/api/remove") {
      stopProject(project);
      data.projects = data.projects.filter(p => p.id !== project.id);
      saveData(data); return sendJson(res, 200, {ok:true});
    }
    if (u.pathname === "/api/shutdown") {
      for (const p of data.projects) stopProject(p);
      sendJson(res, 200, {ok:true});
      setTimeout(() => process.exit(0), 250);
      return;
    }
  }
  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, HOST, async () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  await rescan();
  console.log(`Local App Hub: http://localhost:${PORT}`);
});
process.on("exit", () => { try { fs.unlinkSync(PID_FILE); } catch {} });
