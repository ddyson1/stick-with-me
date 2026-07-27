# stick with me

A wall of notes from strangers — [stick-with-me.com](https://stick-with-me.com)

Pull a blank sticky and write. Several strangers can write at once, each note
glowing while its author types. Two quiet minutes — or **stick it** — sets a
note. One inked note per visitor per hour. When the wall fills (96 notes) it is
shelved and a fresh one begins.

Static shell (GitHub Pages) + a live engine on Cloudflare (Worker + one Durable
Object per wall, WebSocket hibernation). No accounts; notes sign "a stranger"
unless you add a name. Handwriting is Caveat, labels are Special Elite (both
SIL OFL, self-hosted).

Forked from the notebook experiment at
[expressions-of-emptiness](https://github.com/ddyson1/expressions-of-emptiness),
which remains its own thing — a book with one pen.

## Run locally

```sh
python3 -m http.server 8791
# open http://127.0.0.1:8791
```

## Engine

`workers/` — deploy with `npx wrangler deploy`; owner endpoints:

```sh
# strike a note (its slot reopens)
curl -X POST https://WORKER/wall/001/erase -H 'content-type: application/json' \
  -d '{"key":"<OWNER_KEY>","id":"<note id>"}'
```

Kill switch: set `"KILLED": "true"` in `workers/wrangler.jsonc`, redeploy.

## Archiving a full wall

1. `curl https://WORKER/wall/001 > data/wall-001.json` (snapshot)
2. Add `{"id":"001","filled":"YYYY-MM-DD"}` to `data/archive.json`
3. Seed wall 002 (empty) and bump the default id in `index.html`
