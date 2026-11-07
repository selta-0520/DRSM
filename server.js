const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const rnd = a => a[Math.floor(Math.random() * a.length)];
const rid = () => Math.random().toString(36).slice(2, 8);
const newCode = () => { let c; do { c = Array.from({ length: 4 }, () => rnd("ABCDEFGHJKLMNPQRSTUVWXYZ")).join(""); } while (rooms.has(c)); return c; };
const pick = a => {
  if (!a.length) return null;
  const c = {}; a.forEach(x => c[x] = (c[x] || 0) + 1);
  const m = Math.max(...Object.values(c));
  return rnd(Object.keys(c).filter(k => c[k] === m));
};
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") return res.end("ok");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(path.join(__dirname, "index.html")));
});
const wss = new WebSocketServer({ server });

function view(r, p) {
  const live = r.phase === "night" || r.phase === "vote";
  return {
    t: "state", code: r.code, phase: r.phase, day: r.day, me: p.id,
    host: r.hostTok === p.tok,
    players: r.players.map(x => ({ id: x.id, name: x.name, faction: x.faction, on: !!x.ws, done: live && !!r.acts[x.id] })),
    role: r.phase === "lobby" ? null : p.role,
    res: r.phase === "result" ? r.res : null
  };
}
function push(r) { r.at = Date.now(); r.players.forEach(p => send(p.ws, view(r, p))); }

function night(r) {
  const p = Math.random();
  r.day++; r.phase = "night"; r.acts = {}; r.res = null;
  r.players.forEach(x => { x.faction = rnd(["동", "서"]); x.role = Math.random() < p ? "늑대" : "양"; });
}
function advance(r) {
  if (r.phase === "night") { r.phase = "vote"; r.acts = {}; }
  else if (r.phase === "vote") {
    const g = k => r.players.map(x => r.acts[x.id] && r.acts[x.id][k]).filter(Boolean);
    const f = (id, role) => { const x = r.players.find(y => y.id === id); return x ? { id, name: x.name, ok: x.role === role } : null; };
    r.res = { sheep: f(pick(g("sheep")), "양"), wolf: f(pick(g("wolf")), "늑대") };
    r.phase = "result"; r.acts = {};
  } else if (r.phase === "result") night(r);
}

wss.on("connection", ws => {
  let r = null, p = null;
  const err = m => send(ws, { t: "err", m });
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "ping") return;
    if (m.t === "create" || m.t === "join") {
      const name = String(m.name || "").trim().slice(0, 12), tok = String(m.tok || "").slice(0, 40);
      if (!name || !tok) return err("이름을 입력해 주세요.");
      if (m.t === "create") {
        r = { code: newCode(), hostTok: tok, phase: "lobby", day: 0, players: [], acts: {}, res: null, at: Date.now() };
        rooms.set(r.code, r);
      } else {
        r = rooms.get(String(m.code || "").trim().toUpperCase());
        if (!r) { r = null; return send(ws, { t: "gone" }); }
      }
      p = r.players.find(x => x.tok === tok);
      if (!p) {
        if (r.phase !== "lobby") { r = null; return err("이미 시작된 방이에요."); }
        if (r.players.length >= 8) { r = null; return err("방이 가득 찼어요. (최대 8명)"); }
        p = { tok, id: rid(), name, ws: null }; r.players.push(p);
      }
      if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch { } }
      p.ws = ws; p.name = name;
      return push(r);
    }
    if (!r || !p) return;
    const host = r.hostTok === p.tok;
    const valid = id => id !== p.id && r.players.some(x => x.id === id);
    if (m.t === "start" && host && r.phase === "lobby") {
      if (r.players.length < 2) return err("2명 이상 필요해요.");
      night(r);
    } else if (m.t === "act" && r.phase === "night") {
      r.acts[p.id] = { target: valid(m.target) ? m.target : "" };
    } else if (m.t === "vote" && r.phase === "vote") {
      if (!valid(m.sheep) || !valid(m.wolf)) return err("투표 대상이 올바르지 않아요.");
      r.acts[p.id] = { sheep: m.sheep, wolf: m.wolf };
    } else if (host && m.t === "force" && (r.phase === "night" || r.phase === "vote")) advance(r);
    else if (host && m.t === "next" && r.phase === "result") advance(r);
    else if (host && m.t === "reset") {
      r.phase = "lobby"; r.day = 0; r.acts = {}; r.res = null;
      r.players.forEach(x => { x.faction = undefined; x.role = undefined; });
    }
    if ((r.phase === "night" || r.phase === "vote") && r.players.every(x => r.acts[x.id])) advance(r);
    push(r);
  });
  ws.on("close", () => {
    if (!r || !p || p.ws !== ws) return;
    p.ws = null;
    if (r.phase === "lobby") r.players = r.players.filter(x => x !== p);
    push(r);
  });
});
setInterval(() => {
  for (const [c, r] of rooms) if (Date.now() - r.at > 36e5 && r.players.every(x => !x.ws)) rooms.delete(c);
}, 6e5);
server.listen(PORT, () => console.log("listening on " + PORT));
