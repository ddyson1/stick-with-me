/**
 * swm-wall — the live wall engine for stick-with-me.com
 *
 * One Durable Object per wall. Unlike a notebook, a wall is parallel:
 * any stranger can pull a blank sticky and write, several at once, each
 * note glowing while its author types. Two quiet minutes — or "stick it"
 * — sets a note. A full wall (96 notes) is archived; a fresh one begins.
 *
 * WS protocol (JSON):
 *   s→c: state{you,notes,drafts,presence,cap,killed,full}, presence{count},
 *        draft{gid,text,color,x,y}, gone{gid}, ink{note}, deny{reason}
 *   c→s: start{x,y}, write{text}, sign{name}, release
 *
 * Notes carry x/y (fractions of the wall surface) — strangers place
 * their own sticky where they want it.
 */

import { DurableObject } from 'cloudflare:workers';

const BANNED = ['viagra', 'casino', 'crypto giveaway', 'http://', 'https://'];
/* the studio palettes — customization is allowlisted, never free-form */
const COLORS = ['#ffe066', '#ff9fb0', '#8ed6ff', '#b6f2a8', '#ffc78a', '#d9b8ff', '#ffffff'];
const INKS = ['#2c2d30', '#2456d6', '#c23b57', '#1e7a46', '#6b3fb8'];
const FONTS = ['hand', 'type', 'plain'];
const MAX_CHARS = 300;                    /* a sticky, not an essay */
const INK_IDLE_MS = 2 * 60 * 1000;
const EMPTY_DRAFT_MS = 90 * 1000;
const ALARM_TICK_MS = 30 * 1000;
const INK_COOLDOWN_MS = 60 * 60 * 1000;   /* one inked note per ip-hash per hour */

const J = { 'content-type': 'application/json' };

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',');
  const ok = allowed.includes(origin) ? origin : allowed[0];
  return {
    'access-control-allow-origin': ok,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  };
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function keyMatches(env, given) {
  if (!env.OWNER_KEY || !given) return false;
  const a = new TextEncoder().encode(await sha256hex(given));
  const b = new TextEncoder().encode(await sha256hex(env.OWNER_KEY));
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export class Wall extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  _cap() { return parseInt(this.env.NOTES_PER_WALL, 10) || 96; }
  async _notes() { return (await this.ctx.storage.get('notes')) || []; }
  async _drafts() { return (await this.ctx.storage.get('drafts')) || {}; }

  _broadcast(msg, exceptWs) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exceptWs) continue;
      try { ws.send(s); } catch (_) { /* gone */ }
    }
  }

  async _stateFor(gid) {
    const notes = await this._notes();
    const drafts = await this._drafts();
    return {
      t: 'state',
      you: gid,
      id: (await this.ctx.storage.get('id')) || '001',
      cap: this._cap(),
      notes,
      drafts: Object.values(drafts).map((d) => ({ gid: d.gid, text: d.text, color: d.color, ink: d.ink, font: d.font, x: d.x, y: d.y })),
      presence: this.ctx.getWebSockets().length,
      full: false, /* an endless wall does not fill */
      killed: this.env.KILLED === 'true'
    };
  }

  /* ---------- RPC ---------- */

  async getState() { const s = await this._stateFor(null); delete s.you; return s; }

  async seed(id, notes) {
    const existing = await this._notes();
    if (existing.length) return { ok: false, error: 'already seeded' };
    await this.ctx.storage.put('notes', notes);
    await this.ctx.storage.put('id', id);
    return { ok: true, count: notes.length };
  }

  async erase(noteId) {
    const notes = (await this._notes()).filter((n) => n.id !== noteId);
    await this.ctx.storage.put('notes', notes);
    this._broadcast({ t: 'refresh' });
    return { ok: true, count: notes.length };
  }

  async move(noteId, x, y) {
    const notes = await this._notes();
    const n = notes.find((nn) => nn.id === noteId);
    if (!n) return { ok: false, error: 'no such note' };
    n.x = this._pos(x, n.x);
    n.y = this._pos(y, n.y);
    await this.ctx.storage.put('notes', notes);
    this._broadcast({ t: 'refresh' });
    return { ok: true, x: n.x, y: n.y };
  }

  /* ---------- websockets ---------- */

  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const ip = request.headers.get('cf-connecting-ip') || '0.0.0.0';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const gid = crypto.randomUUID().slice(0, 8);
    server.serializeAttachment({ g: gid, iph: await sha256hex(ip), sign: '', lastMsg: 0 });
    server.send(JSON.stringify(await this._stateFor(gid)));
    this._broadcast({ t: 'presence', count: this.ctx.getWebSockets().length });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    const att = ws.deserializeAttachment();

    const now = Date.now();
    if (now - att.lastMsg < 140) return;
    att.lastMsg = now;
    ws.serializeAttachment(att);

    if (this.env.KILLED === 'true') {
      ws.send(JSON.stringify({ t: 'deny', reason: 'the wall is resting.' }));
      return;
    }

    if (msg.t === 'start') return this._start(ws, att, msg);
    if (msg.t === 'write') return this._write(ws, att, msg);
    if (msg.t === 'style') return this._style(ws, att, msg);
    if (msg.t === 'sign') return this._sign(ws, att, msg);
    if (msg.t === 'release') return this._releaseOrInk(att.g, true);
  }

  async webSocketClose(ws) {
    const att = (() => { try { return ws.deserializeAttachment(); } catch (_) { return null; } })();
    if (att) await this._releaseOrInk(att.g, false);
    this._broadcast({ t: 'presence', count: this.ctx.getWebSockets().length });
  }

  async webSocketError(ws) { return this.webSocketClose(ws); }

  /* ---------- drafts ---------- */

  /* world coordinates — the wall is endless; only absurd values are rejected */
  _pos(v, fallback) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(50000, Math.max(-50000, n));
  }

  async _start(ws, att, msg) {
    const notes = await this._notes();
    const drafts = await this._drafts();
    if (drafts[att.g]) return; /* already drafting */
    if (Object.values(drafts).some((d) => d.iph === att.iph)) {
      return ws.send(JSON.stringify({ t: 'deny', reason: 'one note at a time.' }));
    }
    const log = (await this.ctx.storage.get('inklog')) || {};
    if (log[att.iph] && Date.now() - log[att.iph] < INK_COOLDOWN_MS) {
      const mins = Math.max(1, Math.ceil((INK_COOLDOWN_MS - (Date.now() - log[att.iph])) / 60000));
      return ws.send(JSON.stringify({ t: 'deny', reason: 'one note an hour — yours can return in ' + mins + ' min.' }));
    }
    const color = COLORS[(notes.length + Object.keys(drafts).length) % COLORS.length];
    const x = this._pos(msg && msg.x, (Math.random() - 0.5) * 600);
    const y = this._pos(msg && msg.y, (Math.random() - 0.5) * 600);
    drafts[att.g] = {
      gid: att.g, iph: att.iph, color, ink: INKS[0], font: FONTS[0],
      text: '', sign: '', x, y,
      started: Date.now(), lastWrite: Date.now()
    };
    await this.ctx.storage.put('drafts', drafts);
    await this.ctx.storage.setAlarm(Date.now() + ALARM_TICK_MS);
    this._broadcast({ t: 'draft', gid: att.g, text: '', color, ink: INKS[0], font: FONTS[0], x, y });
  }

  async _write(ws, att, msg) {
    const drafts = await this._drafts();
    const d = drafts[att.g];
    if (!d) return ws.send(JSON.stringify({ t: 'deny', reason: 'pull a blank sticky first.' }));
    let text = String(msg.text || '').slice(0, MAX_CHARS);
    const lower = text.toLowerCase();
    if (BANNED.some((w) => lower.includes(w))) {
      return ws.send(JSON.stringify({ t: 'deny', reason: 'that cannot go on the wall.' }));
    }
    d.text = text;
    d.lastWrite = Date.now();
    await this.ctx.storage.put('drafts', drafts);
    this._broadcast({ t: 'draft', gid: att.g, text, color: d.color, ink: d.ink, font: d.font, x: d.x, y: d.y }, ws);
  }

  async _style(ws, att, msg) {
    const drafts = await this._drafts();
    const d = drafts[att.g];
    if (!d) return;
    if (msg.color && COLORS.includes(msg.color)) d.color = msg.color;
    if (msg.ink && INKS.includes(msg.ink)) d.ink = msg.ink;
    if (msg.font && FONTS.includes(msg.font)) d.font = msg.font;
    await this.ctx.storage.put('drafts', drafts);
    this._broadcast({ t: 'style', gid: att.g, color: d.color, ink: d.ink, font: d.font }, ws);
  }

  async _sign(ws, att, msg) {
    att.sign = String(msg.name || '').slice(0, 40);
    ws.serializeAttachment(att);
    const drafts = await this._drafts();
    if (drafts[att.g]) {
      drafts[att.g].sign = att.sign;
      await this.ctx.storage.put('drafts', drafts);
    }
  }

  async _releaseOrInk(gid) {
    const drafts = await this._drafts();
    const d = drafts[gid];
    if (!d) return;
    if (d.text && d.text.trim()) return this._ink(d);
    delete drafts[gid];
    await this.ctx.storage.put('drafts', drafts);
    this._broadcast({ t: 'gone', gid });
  }

  async _ink(d) {
    const notes = await this._notes();
    const note = {
      id: crypto.randomUUID().slice(0, 8),
      text: d.text.trim().slice(0, MAX_CHARS),
      name: (d.sign || '').trim() || 'a stranger',
      color: d.color, ink: d.ink, font: d.font,
      x: d.x, y: d.y,
      inked: new Date().toISOString()
    };
    notes.push(note);
    const log = (await this.ctx.storage.get('inklog')) || {};
    log[d.iph] = Date.now();
    const drafts = await this._drafts();
    delete drafts[d.gid];
    await this.ctx.storage.put({ notes, inklog: log, drafts });
    this._broadcast({ t: 'ink', note, gid: d.gid, full: false });
  }

  async alarm() {
    const drafts = await this._drafts();
    const now = Date.now();
    let changed = false, remaining = 0;
    for (const gid of Object.keys(drafts)) {
      const d = drafts[gid];
      if (d.text && d.text.trim() && now - d.lastWrite >= INK_IDLE_MS) {
        await this._ink(d); changed = true;
      } else if ((!d.text || !d.text.trim()) && now - d.started >= EMPTY_DRAFT_MS) {
        delete drafts[gid];
        await this.ctx.storage.put('drafts', drafts);
        this._broadcast({ t: 'gone', gid });
        changed = true;
      } else {
        remaining++;
      }
    }
    if (remaining > 0) await this.ctx.storage.setAlarm(now + ALARM_TICK_MS);
  }
}

/* ---------------- router ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    const cors = corsHeaders(env, origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const m = url.pathname.match(/^\/wall\/(\d{3})(\/live)?$/);
    const mOwner = url.pathname.match(/^\/wall\/(\d{3})\/(erase|seed|move)$/);

    try {
      if (m && !m[2] && request.method === 'GET') {
        const stub = env.WALL.getByName(m[1]);
        return new Response(JSON.stringify(await stub.getState()), { headers: { ...J, ...cors } });
      }
      if (m && m[2]) {
        const stub = env.WALL.getByName(m[1]);
        return stub.fetch(request);
      }
      if (mOwner && request.method === 'POST') {
        const body = await request.json();
        if (!(await keyMatches(env, body.key))) {
          return new Response(JSON.stringify({ ok: false, error: 'no' }), { status: 403, headers: { ...J, ...cors } });
        }
        const stub = env.WALL.getByName(mOwner[1]);
        const out = mOwner[2] === 'erase' ? await stub.erase(String(body.id))
          : mOwner[2] === 'move' ? await stub.move(String(body.id), body.x, body.y)
          : await stub.seed(mOwner[1], body.notes || []);
        return new Response(JSON.stringify(out), { headers: { ...J, ...cors } });
      }
      return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404, headers: { ...J, ...cors } });
    } catch (err) {
      console.log(JSON.stringify({ event: 'error', path: url.pathname, error: String(err) }));
      return new Response(JSON.stringify({ ok: false, error: 'engine trouble' }), { status: 500, headers: { ...J, ...cors } });
    }
  }
};
