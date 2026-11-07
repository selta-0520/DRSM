const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const rnd = a => a[Math.floor(Math.random() * a.length)];
const rid = () => Math.random().toString(36).slice(2, 8);
const newCode = () => { let c; do { c = Array.from({ length: 4 }, () => rnd("ABCDEFGHJKLMNPQRSTUVWXYZ")).join(""); } while (rooms.has(c)); return c; };
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") return res.end("ok");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(path.join(__dirname, "index.html")));
});
const wss = new WebSocketServer({ server });

const by = (r, id) => r.players.find(x => x.id === id);
const jr = x => x.dg ? "늑대" : x.role;            // 밤 동안의 판정 (위장 반영)
const LIVE = ["draw", "night", "attack", "vote"];
const pend = r => r.phase === "attack" ? r.players.filter(x => x.role === "늑대") : r.players;
const resetP = x => {
  x.score = 0; x.hungry = false; x.fix = undefined; x.ex = false; x.abil = 0; x.howl = 0; x.dis = 0;
  x.pen = false; x.note = ""; x.dg = false; x.lock = false; x.hw = false; x.faction = x.role = undefined;
};

function view(r, p) {
  const mid = r.phase === "result" && r.day % 3 === 0;
  let board = null;
  if (mid || r.phase === "end") {
    const mx = Math.max(...r.players.map(x => x.score));
    board = r.players.map(x => ({ name: x.name, score: x.score, win: r.phase === "end" && x.score === mx })).sort((a, b) => b.score - a.score);
  }
  return {
    t: "state", code: r.code, phase: r.phase, day: r.day, total: r.total, me: p.id,
    host: r.hostTok === p.tok,
    players: r.players.map(x => ({
      id: x.id, name: x.name, faction: r.phase === "draw" ? undefined : x.faction,
      on: !!x.ws || !!x.bot, bot: !!x.bot, ex: !!x.ex, hw: !!(p.hw && x.hw),
      done: LIVE.includes(r.phase) && (!pend(r).includes(x) || !!r.acts[x.id])
    })),
    role: (r.phase === "lobby" || r.phase === "end" || r.phase === "draw") ? null : p.role,
    need: r.phase === "vote" ? r.need : null, cand: r.phase === "vote" ? r.cand : null,
    res: r.phase === "result" ? r.res : null, board,
    pub: r.pub || [],
    note: ["attack", "vote", "result"].includes(r.phase) ? (p.note || "") : "",
    my: { abil: p.abil || 0, howl: p.howl || 0, dis: p.dis || 0, lock: !!p.lock, lockRole: (r.phase === "draw" && p.lock) ? p.role : null, score: p.score || 0 }
  };
}
function push(r) { r.at = Date.now(); r.players.forEach(p => send(p.ws, view(r, p))); }

function deal(r) {
  const p = Math.random();
  r.day++; r.phase = "draw"; r.acts = {}; r.res = null; r.pub = []; r.sk = {};
  r.players.forEach(x => {
    x.faction = rnd(["동", "서"]); x.lock = !!x.fix;
    x.role = x.fix || (Math.random() < p ? "늑대" : "양");
    x.fix = undefined; x.note = ""; x.dg = false; x.hw = false;
  });
  if (r.players.every(x => x.abil >= 2 || x.lock)) r.phase = "night";
}
function resolveNight(r) {
  const penal = r.players.filter(x => x.pen); penal.forEach(x => { x.pen = false; });
  const sheep = r.players.filter(x => x.role === "양");
  sheep.forEach(x => { if (r.sk[x.id] === "disguise" && x.dis < 1) { x.dg = true; x.dis++; } });
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
    const k = r.sk[x.id], n = (att[x.id] || []).length;
    if (k === "shepherd") {
      if (n) { x.score += 2; x.note = n + "명이 당신을 공격했어요."; att[x.id].forEach(w => { w.fix = "늑대"; }); } else x.score -= 2;
    } else if (k === "hunter") {
      if (n) { x.score += 1; att[x.id].forEach(w => { w.pen = true; }); } else x.score -= 4;
    } else if (!n) x.score += 3;
  });
  penal.forEach(x => { x.score -= 2; });   // 사냥꾼 효과: 이번 턴 점수 계산 뒤 -2
}
function toVote(r) {
  r.phase = "vote"; r.acts = {}; r.round = 1; r.keep = {};
  const ok = r.players.some(x => !x.ex);   // 후보가 없으면 자동 기권
  r.need = { sheep: ok, wolf: ok }; r.cand = { sheep: null, wolf: null };
}
function afterNight(r) { resolveNight(r); toVote(r); if (!r.need.sheep && !r.need.wolf) advance(r); }
function advance(r) {
  if (r.phase === "draw") {
    r.players.forEach(x => {
      const a = r.acts[x.id];
      if (a && a.ab) { x.abil++; x.faction = a.faction; x.role = a.role; r.pub.push(x.name + "님이 진영 및 역할 선택 능력을 사용했습니다."); }
    });
    r.phase = "night"; r.acts = {};
  } else if (r.phase === "night") {
    r.sk = {};
    r.players.forEach(x => { const a = r.acts[x.id] || {}; if (x.role === "양" && a.skill) r.sk[x.id] = a.skill; });
    const hs = r.players.filter(w => w.role === "늑대" && (r.acts[w.id] || {}).howl);
    hs.forEach(w => { w.howl++; w.hw = true; });
    if (hs.length === 1) { hs[0].score -= 2; r.pub.push(hs[0].name + "님이 늑대라는 사실이 밝혀졌습니다."); }
    else hs.forEach(w => { w.note = "하울링한 늑대: " + hs.map(y => y.name).join(", "); });
    r.acts = {};
    if (r.players.some(x => x.role === "늑대")) r.phase = "attack"; else afterNight(r);
  } else if (r.phase === "attack") afterNight(r);
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
      const ok = x.role === role;           // 투표는 위장과 상관없이 실제 역할 기준
      if (ok) { x.fix = role; x.ex = true; } else r.players.forEach(y => { if (y !== x) y.score -= 2; });
      return { id, name: x.name, ok };
    };
    r.res = { sheep: apply(win.sheep, "양"), wolf: apply(win.wolf, "늑대") };
    r.phase = "result"; r.acts = {};
  } else if (r.phase === "result") { if (r.day >= r.total) r.phase = "end"; else deal(r); }
}

function botAct(r, x) {
  const others = r.players.filter(y => y.id !== x.id).map(y => y.id);
  if (r.phase === "draw") r.acts[x.id] = { ab: false };
  else if (r.phase === "night") r.acts[x.id] = x.role === "늑대"
    ? { howl: x.howl < 3 && Math.random() < .3 }
    : { skill: rnd(["", "", "shepherd", "hunter", x.dis < 1 ? "disguise" : ""]) };
  else if (r.phase === "attack") r.acts[x.id] = { target: Math.random() < .15 ? "" : (rnd(others) || "") };
  else if (r.phase === "vote") {
    const f = k => r.players.filter(y => !y.ex && (!r.cand[k] || r.cand[k].includes(y.id))).map(y => y.id);
    r.acts[x.id] = { sheep: r.need.sheep ? (rnd(f("sheep")) || "") : "", wolf: r.need.wolf ? (rnd(f("wolf")) || "") : "" };
  }
}
function settle(r) {
  for (let i = 0; i < 60 && LIVE.includes(r.phase); i++) {
    r.players.filter(x => x.bot && !r.acts[x.id] && pend(r).includes(x)).forEach(x => botAct(r, x));
    if (pend(r).every(x => r.acts[x.id])) advance(r); else break;
  }
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
        r = { code: newCode(), hostTok: tok, phase: "lobby", day: 0, players: [], acts: {}, res: null, pub: [], sk: {}, at: Date.now() };
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
      r.players.forEach(resetP);
      deal(r);
    } else if (m.t === "addbot" && host && r.phase === "lobby") {
      if (r.players.length >= 8) return err("방이 가득 찼어요. (최대 8명)");
      const n = r.players.filter(x => x.bot).length + 1;
      r.players.push({ tok: "bot-" + rid(), id: rid(), name: "봇" + n, ws: null, bot: true });
    } else if (m.t === "rmbot" && host && r.phase === "lobby") {
      const b = r.players.filter(x => x.bot).pop();
      if (b) r.players = r.players.filter(x => x !== b);
    } else if (m.t === "draw" && r.phase === "draw") {
      const ok = m.ab && p.abil < 2 && !p.lock && ["동", "서"].includes(m.faction) && ["양", "늑대"].includes(m.role);
      r.acts[p.id] = ok ? { ab: true, faction: m.faction, role: m.role } : { ab: false };
    } else if (m.t === "act" && r.phase === "night") {
      r.acts[p.id] = p.role === "늑대"
        ? { howl: !!m.howl && p.howl < 3 }
        : { skill: (m.skill === "shepherd" || m.skill === "hunter" || (m.skill === "disguise" && p.dis < 1)) ? m.skill : "" };
    } else if (m.t === "attack" && r.phase === "attack" && p.role === "늑대") {
      r.acts[p.id] = { target: valid(m.target) ? m.target : "" };
    } else if (m.t === "vote" && r.phase === "vote") {
      const okv = (k, id) => !r.need[k] || (r.players.some(x => x.id === id && !x.ex) && (!r.cand[k] || r.cand[k].includes(id)));
      if (!okv("sheep", m.sheep) || !okv("wolf", m.wolf)) return err("투표 대상이 올바르지 않아요.");
      r.acts[p.id] = { sheep: m.sheep, wolf: m.wolf };
    } else if (host && m.t === "force" && LIVE.includes(r.phase)) advance(r);
    else if (host && m.t === "next" && r.phase === "result") advance(r);
    else if (host && m.t === "reset") {
      r.phase = "lobby"; r.day = 0; r.acts = {}; r.res = null; r.pub = []; r.sk = {};
      r.players.forEach(resetP);
    }
    settle(r);
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
