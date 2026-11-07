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

const by = (r, id) => r.players.find(x => x.id === id);
const jr = x => x.dg ? "늑대" : x.role;
const LIVE = ["draw", "night", "vote"];
function view(r, p) {
  const board = (r.phase === "result" && r.day % 3 === 0) || r.phase === "end"
    ? r.players.map(x => ({ name: x.name, score: x.score })).sort((a, b) => b.score - a.score) : null;
  return {
    t: "state", code: r.code, phase: r.phase, day: r.day, total: r.total, me: p.id,
    host: r.hostTok === p.tok,
    players: r.players.map(x => ({ id: x.id, name: x.name, faction: (r.phase === "draw" && x !== p) ? undefined : x.faction, on: !!x.ws, ex: !!x.ex, done: LIVE.includes(r.phase) && !!r.acts[x.id] })),
    role: (r.phase === "lobby" || r.phase === "end") ? null : p.role,
    need: r.phase === "vote" ? r.need : null, cand: r.phase === "vote" ? r.cand : null,
    res: r.phase === "result" ? r.res : null, board,
    pub: r.pub || [], note: (r.phase === "vote" || r.phase === "result") ? (p.note || "") : "",
    my: { abil: p.abil || 0, howl: p.howl || 0, dis: p.dis || 0, lock: !!p.lock }
  };
}
function push(r) { r.at = Date.now(); r.players.forEach(p => send(p.ws, view(r, p))); }

function deal(r) {
  const p = Math.random();
  r.day++; r.phase = "draw"; r.acts = {}; r.res = null; r.pub = [];
  r.players.forEach(x => {
    x.faction = rnd(["동", "서"]); x.lock = !!x.fix;
    x.role = x.fix || (Math.random() < p ? "늑대" : "양");
    x.fix = undefined; x.note = ""; x.dg = false;
  });
  if (r.players.every(x => x.abil >= 2 || x.lock)) r.phase = "night";
}
function resolveNight(r) {
  r.players.forEach(x => { if (x.pen) { x.score -= 2; x.pen = false; } });
  const sheep = r.players.filter(x => x.role === "양");
  sheep.forEach(x => { const a = r.acts[x.id]; if (a && a.skill === "disguise" && x.dis < 1) { x.dg = true; x.dis++; } });
  const att = {};
  r.players.filter(w => w.role === "늑대").forEach(w => {
    const a = r.acts[w.id], t = a && a.target ? by(r, a.target) : null;
    const h = w.hungry; w.hungry = false;
    if (!t) { w.score -= 1; w.hungry = true; return; }
    (att[t.id] = att[t.id] || []).push(w);
    const same = t.faction === w.faction;
    if (jr(t) === "양") w.score += (same ? 1 : 3) * (h ? 2 : 1);
    else w.score += same ? (h ? -1 : 0) : (h ? -6 : -3);
  });
  sheep.filter(x => !x.dg).forEach(x => {
    const k = (r.acts[x.id] || {}).skill, n = (att[x.id] || []).length;
    if (k === "shepherd") {
      if (n) { x.score += 2; x.note = n + "명이 당신을 공격했어요."; att[x.id].forEach(w => { w.fix = "늑대"; }); } else x.score -= 2;
    } else if (k === "hunter") {
      if (n) { x.score += 1; att[x.id].forEach(w => { w.pen = true; }); } else x.score -= 4;
    } else if (!n) x.score += 3;
  });
  const hs = r.players.filter(w => w.role === "늑대" && (r.acts[w.id] || {}).howl);
  hs.forEach(w => { w.howl++; });
  if (hs.length === 1) { hs[0].score -= 2; r.pub.push(hs[0].name + "님이 늑대라는 사실이 밝혀졌어요."); }
  else hs.forEach(w => { w.note += (w.note ? " " : "") + "하울링한 늑대: " + hs.map(y => y.name).join(", "); });
}
function toVote(r) {
  r.phase = "vote"; r.acts = {}; r.round = 1;
  r.need = { sheep: true, wolf: true }; r.cand = { sheep: null, wolf: null }; r.keep = {};
}
function advance(r) {
  if (r.phase === "draw") {
    r.players.forEach(x => {
      const a = r.acts[x.id];
      if (a && a.ab) { x.abil++; x.faction = a.faction; x.role = a.role; r.pub.push(x.name + "님이 능력을 사용했어요."); }
    });
    r.phase = "night"; r.acts = {};
  } else if (r.phase === "night") { resolveNight(r); toVote(r); }
  else if (r.phase === "vote") {
    const g = k => r.players.map(x => r.acts[x.id] && r.acts[x.id][k]).filter(Boolean);
    const top = a => { const c = {}; a.forEach(x => c[x] = (c[x] || 0) + 1); const m = Math.max(0, ...Object.values(c)); return Object.keys(c).filter(k => m > 0 && c[k] === m); };
    const win = {}, tied = {};
    for (const k of ["sheep", "wolf"]) {
      if (!r.need[k]) { win[k] = r.keep[k]; continue; }
      const t = top(g(k));
      if (t.length > 1 && r.round === 1) tied[k] = t; else win[k] = t.length ? rnd(t) : null;
    }
    if (Object.keys(tied).length) {
      r.round = 2; r.acts = {};
      for (const k of ["sheep", "wolf"]) { if (tied[k]) r.cand[k] = tied[k]; else { r.keep[k] = win[k]; r.need[k] = false; } }
      return;
    }
    r.players.forEach(x => { x.ex = false; });
    const apply = (id, role) => {
      const x = by(r, id); if (!x) return null;
      const ok = jr(x) === role;
      if (ok) { x.fix = role; x.ex = true; } else r.players.forEach(y => { if (y !== x) y.score -= 2; });
      return { id, name: x.name, ok };
    };
    r.res = { sheep: apply(win.sheep, "양"), wolf: apply(win.wolf, "늑대") };
    r.phase = "result"; r.acts = {};
  } else if (r.phase === "result") { if (r.day >= r.total) r.phase = "end"; else deal(r); }
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
      r.total = [3, 10, 15, 20].includes(+m.total) ? +m.total : 10;
      r.players.forEach(x => { x.score = 0; x.hungry = false; x.fix = undefined; x.ex = false; x.abil = 0; x.howl = 0; x.dis = 0; x.pen = false; x.note = ""; x.dg = false; x.lock = false; });
      deal(r);
    } else if (m.t === "act" && r.phase === "night") {
      r.acts[p.id] = p.role === "늑대"
        ? { target: valid(m.target) ? m.target : "", howl: !!m.howl && p.howl < 3 }
        : { skill: (m.skill === "shepherd" || m.skill === "hunter" || (m.skill === "disguise" && p.dis < 1)) ? m.skill : "" };
    } else if (m.t === "draw" && r.phase === "draw") {
      const ok = m.ab && p.abil < 2 && !p.lock && ["동", "서"].includes(m.faction) && ["양", "늑대"].includes(m.role);
      r.acts[p.id] = ok ? { ab: true, faction: m.faction, role: m.role } : { ab: false };
    } else if (m.t === "vote" && r.phase === "vote") {
      const okv = (k, id) => !r.need[k] || (id !== p.id && r.players.some(x => x.id === id && !x.ex) && (!r.cand[k] || r.cand[k].includes(id)));
      if (!okv("sheep", m.sheep) || !okv("wolf", m.wolf)) return err("투표 대상이 올바르지 않아요.");
      r.acts[p.id] = { sheep: m.sheep, wolf: m.wolf };
    } else if (host && m.t === "force" && LIVE.includes(r.phase)) advance(r);
    else if (host && m.t === "next" && r.phase === "result") advance(r);
    else if (host && m.t === "reset") {
      r.phase = "lobby"; r.day = 0; r.acts = {}; r.res = null;
      r.players.forEach(x => { x.faction = x.role = x.fix = undefined; x.score = 0; x.hungry = false; x.ex = false; x.abil = 0; x.howl = 0; x.dis = 0; x.pen = false; x.note = ""; x.dg = false; x.lock = false; });
    }
    if (LIVE.includes(r.phase) && r.players.every(x => r.acts[x.id])) advance(r);
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
