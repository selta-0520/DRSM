const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const MAXP = 50;   // 서버 보호용 안전 상한
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
const LIVE = ["draw", "howl", "night", "vote"];
const pend = r => r.phase === "howl" ? r.players.filter(x => x.role === "늑대") : r.players;
const add = (x, d, w, k) => { x.score += d; (x.log = x.log || []).push({ k, d, w }); };
const info = (x, w, k) => add(x, 0, w, k);
const resetP = x => {
  x.log = []; x.score = 0; x.hungry = false; x.fix = undefined; x.ex = false; x.abil = 0; x.howl = 0; x.dis = 0;
  x.pen = false; x.note = ""; x.dg = false; x.lock = false; x.hw = false; x.faction = x.role = undefined;
};

function view(r, p) {
  const mid = r.phase === "result" && r.every > 0 && r.day % r.every === 0;
  let board = null;
  if (mid || r.phase === "end") {
    const mx = Math.max(...r.players.map(x => x.score));
    board = r.players.map(x => ({ name: x.name, score: x.score, win: r.phase === "end" && x.score === mx })).sort((a, b) => b.score - a.score);
  }
  return {
    t: "state", code: r.code, phase: r.phase, day: r.day, total: r.total, every: r.every, me: p.id,
    host: r.hostTok === p.tok,
    players: r.players.map(x => ({
      id: x.id, name: x.name, faction: r.phase === "draw" ? undefined : x.faction,
      on: !!x.ws || !!x.bot, bot: !!x.bot, ex: !!x.ex, hw: !!(p.hw && x.hw),
      done: LIVE.includes(r.phase) && (!pend(r).includes(x) || !!r.acts[x.id])
    })),
    role: (r.phase === "lobby" || r.phase === "end" || r.phase === "draw") ? null : p.role,
    need: r.phase === "vote" ? r.need : null, cand: r.phase === "vote" ? r.cand : null,
    res: r.phase === "result" ? r.res : null, board,
    log: (r.phase === "result" || r.phase === "end") ? (p.log || []) : null,
    pub: r.pub || [],
    note: ["night", "vote", "result"].includes(r.phase) ? (p.note || "") : "",
    my: { abil: p.abil || 0, howl: p.howl || 0, dis: p.dis || 0, lock: !!p.lock, lockRole: (r.phase === "draw" && p.lock) ? p.role : null, score: (r.phase === "result" || r.phase === "end") ? (p.score || 0) : null }
  };
}
function push(r) { r.at = Date.now(); r.players.forEach(p => send(p.ws, view(r, p))); }

function deal(r) {
  const p = Math.random();
  r.day++; r.phase = "draw"; r.acts = {}; r.res = null; r.pub = []; r.sk = {};
  r.players.forEach(x => {
    x.faction = rnd(["동", "서"]); x.lock = !!x.fix;
    x.role = x.fix || (Math.random() < p ? "늑대" : "양");
    x.fix = undefined; x.note = ""; x.dg = false; x.hw = false; x.log = [];
  });
  if (r.players.every(x => x.abil >= 2 || x.lock)) startNight(r);
}
function startNight(r) { r.acts = {}; r.phase = r.players.some(x => x.role === "늑대") ? "howl" : "night"; }
function resolveNight(r) {
  const penal = r.players.filter(x => x.pen); penal.forEach(x => { x.pen = false; });
  const sheep = r.players.filter(x => x.role === "양");
  sheep.forEach(x => { if (r.sk[x.id] === "disguise" && x.dis < 1) { x.dg = true; x.dis++; } });
  const att = {};
  r.players.filter(w => w.role === "늑대").forEach(w => {
    const a = r.acts[w.id], t = a && a.target ? by(r, a.target) : null;
    const h = w.hungry; w.hungry = false;
    if (!t) { add(w, -1, "공격을 포기했어요. 굶주림 상태가 돼요.", "n"); w.hungry = true; return; }
    (att[t.id] = att[t.id] || []).push(w);
    const same = t.faction === w.faction, tr = jr(t);
    const d = tr === "양" ? (same ? 1 : 3) * (h ? 2 : 1) : (same ? (h ? -1 : 0) : (h ? -6 : -3));
    add(w, d, t.name + "님(" + (same ? "같은" : "다른") + " 진영 " + tr + ")을 공격했어요." + (h ? " 굶주림 상태였어요." : ""), "n");
  });
  sheep.forEach(x => {
    const k = r.sk[x.id], n = (att[x.id] || []).length;
    if (x.dg) {
      info(x, "늑대로 위장해서 이번 밤 점수를 받지 못해요.", "n");
      if (n) info(x, "위장한 상태에서 늑대에게 공격받았어요. (늑대로 판정)", "n");
      return;
    }
    if (k === "shepherd") {
      if (n) { add(x, 2, "양치기를 불렀고 늑대에게 공격받았어요. 공격한 늑대는 " + n + "명이에요.", "n"); x.note = n + "명이 당신을 공격했어요."; att[x.id].forEach(w => { w.fix = "늑대"; }); }
      else add(x, -2, "양치기를 불렀지만 공격받지 않았어요.", "n");
    } else if (k === "hunter") {
      if (n) { add(x, 1, "사냥꾼을 불렀고 늑대에게 공격받았어요.", "n"); att[x.id].forEach(w => { w.pen = true; }); }
      else add(x, -4, "사냥꾼을 불렀지만 공격받지 않았어요.", "n");
    } else if (n) info(x, "늑대에게 공격받아 생존 점수를 받지 못했어요.", "n");
    else add(x, 3, "아무 행동도 하지 않고 살아남았어요.", "n");
  });
  penal.forEach(x => add(x, -2, "지난 턴에 사냥꾼을 부른 양을 공격해서, 이번 턴 점수 계산 뒤에 -2점이에요.", "n"));
}
function toVote(r) {
  r.phase = "vote"; r.acts = {}; r.round = 1; r.keep = {};
  const ok = r.players.some(x => !x.ex);   // 후보가 없으면 자동 기권
  r.need = { sheep: ok, wolf: ok }; r.cand = { sheep: null, wolf: null }; r.tal = { sheep: [], wolf: [] };
}
function afterNight(r) { resolveNight(r); toVote(r); if (!r.need.sheep && !r.need.wolf) advance(r); }
function advance(r) {
  if (r.phase === "draw") {
    r.players.forEach(x => {
      const a = r.acts[x.id];
      if (a && a.ab) { x.abil++; x.faction = a.faction; x.role = a.role; r.pub.push(x.name + "님이 진영 및 역할 선택 능력을 사용했습니다."); }
    });
    startNight(r);
  } else if (r.phase === "howl") {
    const hs = r.players.filter(w => w.role === "늑대" && (r.acts[w.id] || {}).howl);
    hs.forEach(w => { w.howl++; w.hw = true; });
    if (hs.length === 1) { add(hs[0], -2, "하울링을 혼자 써서 늑대라는 사실이 모두에게 밝혀졌어요.", "n"); r.pub.push(hs[0].name + "님이 늑대라는 사실이 밝혀졌습니다."); }
    else hs.forEach(w => { w.note = "하울링한 늑대: " + hs.map(y => y.name).join(", "); info(w, w.note, "n"); });
    r.acts = {}; r.phase = "night";
  } else if (r.phase === "night") {
    r.sk = {};
    r.players.forEach(x => { const a = r.acts[x.id] || {}; if (x.role === "양" && a.skill) r.sk[x.id] = a.skill; });
    afterNight(r);
  }
  else if (r.phase === "vote") {
    const g = k => r.players.map(x => r.acts[x.id] && r.acts[x.id][k]).filter(Boolean);
    const top = a => { const c = {}; a.forEach(x => c[x] = (c[x] || 0) + 1); const m = Math.max(0, ...Object.values(c)); return Object.keys(c).filter(k => m > 0 && c[k] === m); };
    const cnt = k => { const c = {}; g(k).forEach(id => { c[id] = (c[id] || 0) + 1; }); return Object.entries(c).map(([id, n]) => ({ name: (by(r, id) || {}).name || "?", n })).sort((a, b) => b.n - a.n); };
    const win = {}, tied = {};
    for (const k of ["sheep", "wolf"]) {
      if (!r.need[k]) { win[k] = r.keep[k]; continue; }
      r.tal[k].push(cnt(k));
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
      const lb = role + " 투표";
      if (ok) { x.fix = role; x.ex = true; info(x, lb + " 1위로 뽑혔어요. 정체가 맞아서 다음 턴에 " + (role === "양" ? "양으로" : "늑대로") + " 고정되고 다음 투표 후보에서 제외돼요.", "v"); }
      else {
        info(x, lb + " 1위로 뽑혔어요. 정체가 아니라서 다른 모두가 -2점을 받아요.", "v");
        r.players.forEach(y => { if (y !== x) add(y, -2, lb + " 1위(" + x.name + "님)의 정체가 " + role + (role === "양" ? "이" : "가") + " 아니었어요.", "v"); });
      }
      return { id, name: x.name, ok };
    };
    r.res = { sheep: apply(win.sheep, "양"), wolf: apply(win.wolf, "늑대"), tal: r.tal };
    r.phase = "result"; r.acts = {};
  } else if (r.phase === "result") { if (r.day >= r.total) r.phase = "end"; else deal(r); }
}

function afterKick(r) {
  if (r.phase === "lobby") return;
  if (r.players.length < 2) {
    r.phase = "lobby"; r.day = 0; r.acts = {}; r.res = null; r.pub = []; r.sk = {};
    r.players.forEach(resetP); return;
  }
  if (r.phase === "vote") {
    const ids = new Set(r.players.map(x => x.id));
    for (const k of ["sheep", "wolf"]) {
      if (r.cand[k]) { r.cand[k] = r.cand[k].filter(id => ids.has(id)); if (r.need[k] && !r.cand[k].length) { r.need[k] = false; r.keep[k] = null; } }
      if (r.need[k] && !r.players.some(x => !x.ex)) { r.need[k] = false; r.keep[k] = null; }
    }
    if (!r.need.sheep && !r.need.wolf) advance(r);
  }
}

function botAct(r, x) {
  const others = r.players.filter(y => y.id !== x.id).map(y => y.id);
  if (r.phase === "draw") r.acts[x.id] = { ab: false };
  else if (r.phase === "howl") r.acts[x.id] = { howl: x.howl < 3 && Math.random() < .3 };
  else if (r.phase === "night") r.acts[x.id] = x.role === "늑대"
    ? { target: Math.random() < .15 ? "" : (rnd(others) || "") }
    : { skill: rnd(["", "", "shepherd", "hunter", x.dis < 1 ? "disguise" : ""]) };
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
        r = { code: newCode(), hostTok: tok, phase: "lobby", day: 0, players: [], acts: {}, res: null, pub: [], sk: {}, banned: new Set(), total: 10, every: 3, at: Date.now() };
        rooms.set(r.code, r);
      } else {
        r = rooms.get(String(m.code || "").trim().toUpperCase());
        if (!r) { r = null; return send(ws, { t: "gone" }); }
      }
      if (r.banned.has(tok)) { r = null; return err("이 방에서 추방되어 다시 들어올 수 없어요."); }
      p = r.players.find(x => x.tok === tok);
      if (!p) {
        if (r.phase !== "lobby") { r = null; return err("이미 시작된 방이에요."); }
        if (r.players.length >= MAXP) { r = null; return err("방이 가득 찼어요. (최대 " + MAXP + "명)"); }
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
      const tn = Math.floor(+m.total), ev = Math.floor(+m.every);
      r.total = Number.isFinite(tn) ? Math.max(1, Math.min(99, tn)) : 10;
      r.every = Number.isFinite(ev) ? Math.max(0, Math.min(99, ev)) : 3;
      r.players.forEach(resetP);
      deal(r);
    } else if (m.t === "addbot" && host && r.phase === "lobby") {
      if (r.players.length >= MAXP) return err("방이 가득 찼어요. (최대 " + MAXP + "명)");
      const n = r.players.filter(x => x.bot).length + 1;
      r.players.push({ tok: "bot-" + rid(), id: rid(), name: "봇" + n, ws: null, bot: true });
    } else if (m.t === "rmbot" && host && r.phase === "lobby") {
      const b = r.players.filter(x => x.bot).pop();
      if (b) r.players = r.players.filter(x => x !== b);
    } else if (m.t === "kick" && host) {
      const t = r.players.find(x => x.id === m.id);
      if (!t || t === p) return err("추방할 수 없는 대상이에요.");
      r.banned.add(t.tok);
      const w = t.ws; t.ws = null;
      send(w, { t: "kicked" }); try { w && w.close(); } catch { }
      r.players = r.players.filter(x => x !== t); delete r.acts[t.id];
      afterKick(r);
    } else if (m.t === "draw" && r.phase === "draw") {
      const ok = m.ab && p.abil < 2 && !p.lock && ["동", "서"].includes(m.faction) && ["양", "늑대"].includes(m.role);
      r.acts[p.id] = ok ? { ab: true, faction: m.faction, role: m.role } : { ab: false };
    } else if (m.t === "howl" && r.phase === "howl" && p.role === "늑대") {
      r.acts[p.id] = { howl: !!m.howl && p.howl < 3 };
    } else if (m.t === "act" && r.phase === "night") {
      r.acts[p.id] = p.role === "늑대"
        ? { target: valid(m.target) ? m.target : "" }
        : { skill: (m.skill === "shepherd" || m.skill === "hunter" || (m.skill === "disguise" && p.dis < 1)) ? m.skill : "" };
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
