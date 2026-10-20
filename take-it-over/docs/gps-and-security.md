# GPS, background limits and anti-cheat

## How capture works

1. The app watches the device position (`navigator.geolocation.watchPosition`,
   high accuracy) and sends the latest fix about once a second over the
   WebSocket (HTTP fallback). While the device stands still, the browser may
   not report new positions, so the last fix is re-sent while it is less than
   8 seconds old.
2. The server ignores fixes with a declared accuracy worse than **20 m**.
3. The server maps each fix to a cell and times how long the player has been
   continuously in it, using **its own clock**. The timer restarts when the
   cell changes, after an inaccurate fix, after an implausible jump, or after
   a silence longer than 10 seconds (provisional).
4. After **2 seconds** in a neutral land cell the server claims it. Claims are
   race-free: two players in the same cell at the same moment cannot both win.
5. Enemy territory and water are never captured by GPS. Isolated parcels are
   allowed and any travel speed is allowed.

The client never says "I captured this"; it only reports where it is.

## Limits of GPS in a PWA

- **Foreground only.** Browsers suspend JavaScript and geolocation when a web
  app is in the background or the screen is off. Capture works only while the
  game is open on screen. An optional *keep screen awake* setting uses the
  Screen Wake Lock API where supported. A native wrapper (Capacitor and
  similar) would be needed for background capture; that is a product decision.
- **Secure origins.** Geolocation and service workers require HTTPS (or
  `localhost`).
- **Accuracy is self-declared.** The device reports its own accuracy
  estimate; it is not proof. Indoors and in dense cities it often exceeds
  20 m, and those fixes are ignored.
- **Spoofing.** Any GPS game can be fooled by mock-location apps or modified
  clients. The server cannot verify a fix cryptographically; it can only make
  abuse costly and visible.

## Anti-cheat: permissive by design

- Every fix is checked against the previous one. An implied speed above
  1,200 km/h over more than 500 m is recorded as an anomaly (speed, distance,
  time gap, target cell; never coordinates). Planes, trains and cars are fine.
- **A single jump is never treated as proof.** It only restarts the dwell
  timer.
- Only repeated anomalies (30 within 24 hours, provisional) suspend GPS
  capture, for 12 hours (provisional). Drones, wars and income are not
  affected. The player sees the suspension in the app.
- Fixes arriving faster than every 250 ms are dropped (rate limit).
- Anomaly records are deleted after 30 days.

Thresholds are parameters, so they can be tuned without code changes once real
data exists.

## Location privacy

- No location history is stored. The server keeps only each player's latest
  fix, in memory, for capture timing and to launch drones from the real
  position.
- Exploration rewards (for players with no territory) store coarse 0.1° zone
  ids (about 11 km), and only while the player holds no territory.

## Application security summary

| Area | Measure |
|---|---|
| Passwords | scrypt (N=2¹⁵, r=8, p=1), per-user salt, constant-time compare, same timing for unknown users |
| Sessions | 256-bit random token in an HttpOnly, SameSite=Lax cookie (Secure in production); only SHA-256 stored; 30-day expiry |
| CSRF | custom `X-TIO-Client` header on every state change + Origin check; WebSocket origin check |
| Input | zod schemas on every endpoint; range checks for coordinates, cell ids, unit counts |
| Abuse | per-player/IP rate limits; stricter on login and registration |
| Money | row locks, settled balances, idempotency keys, integer credit units, ledger of every movement |
| Authority | all game rules evaluated on the server; the client is never trusted |
