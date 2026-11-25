// Dashboard: Today (levels, Phase 2) and Data (candles, Phase 1) — Supabase edition.
// Reads tables through owner-only RLS and calls the `api` Edge Function. No order actions anywhere.
const { supabaseUrl, supabaseKey } = window.NIFTY_CONFIG;
const sb = window.supabase.createClient(supabaseUrl, supabaseKey);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (x, d = 2) => (x == null ? "–" : Number(x).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: d }));

// ---------- data helpers
async function rows(q) {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
const one = async (q) => (await rows(q.maybeSingle())) ?? null;
const config = async (key) => (await one(sb.from("app_config").select("value").eq("key", key)))?.value ?? null;

/** Call the `api` Edge Function; throws Error(message) with the server's error text. */
async function api(action, extra = {}) {
  const { data, error } = await sb.functions.invoke("api", { body: { action, ...extra } });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return data;
}

// levels row (snake_case) -> the shape the views use
function lvFromRow(d) {
  if (!d || d.p == null) return null;
  return {
    date: d.date, based_on: d.based_on, P: d.p, BC: d.bc, TC: d.tc, R1: d.r1, R2: d.r2, S1: d.s1, S2: d.s2,
    PDH: d.pdh, PDL: d.pdl, PDC: d.pdc, cpr_width: d.cpr_width, no_trade: d.no_trade,
    maxCallOI: d.max_call_oi, maxCallOI_oi: d.max_call_oi_oi, maxPutOI: d.max_put_oi, maxPutOI_oi: d.max_put_oi_oi,
    call_oi_top: d.call_oi_top, put_oi_top: d.put_oi_top, oi_expiry: d.oi_expiry, oi_spot: d.oi_spot, oi_at: d.oi_at,
  };
}

// ---------- date helpers (IST)
const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const shiftDate = (iso, days) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const fmtTime = (ts) => new Date(ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDay = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

// ---------- tabs
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $("tab-today").classList.toggle("hidden", name !== "today");
  $("tab-data").classList.toggle("hidden", name !== "data");
  $("tab-signals").classList.toggle("hidden", name !== "signals");
  if (name === "data") { loadDay($("day").value); loadLogs(); }
  if (name === "signals") loadSignals();
}

// ---------- auth (email + password; owner account only)
$("signin-form").onsubmit = async (e) => {
  e.preventDefault();
  $("signin-error").textContent = "";
  $("btn-signin").disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: $("si-email").value.trim(), password: $("si-password").value });
  $("btn-signin").disabled = false;
  if (error) $("signin-error").textContent = error.message;
};

let shownFor; // undefined until the first auth event, so the signed-out view is shown too
sb.auth.onAuthStateChange((_event, session) => {
  const user = session?.user ?? null;
  if ((user?.id ?? null) === shownFor) return; // ignore token refreshes
  shownFor = user?.id ?? null;
  // Run outside the auth callback (supabase-js recommends not awaiting inside it).
  setTimeout(() => onUser(user), 0);
});

async function onUser(user) {
  $("signed-out").classList.toggle("hidden", !!user);
  $("app").classList.toggle("hidden", !user);
  $("user-box").innerHTML = user ? `${esc(user.email)} <button id="btn-signout">Sign out</button>` : "";
  if (!user) return;
  $("btn-signout").onclick = () => sb.auth.signOut();
  try {
    if (!(await rows(sb.rpc("is_owner")))) {
      $("app").innerHTML = `<section class="card error">This account is not the owner. Sign out and use the owner account.</section>`;
      return;
    }
    await Promise.all([loadUpstoxStatus(), loadLevels()]);
  } catch (e) {
    console.error(e);
    $("levels").innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

// ---------- Upstox login
/** Updates the Upstox box; returns true when logged in. */
async function loadUpstoxStatus() {
  const s = await config("upstox_status");
  const el = $("upstox-status");
  const exp = s?.expires_at ? new Date(s.expires_at) : null;
  const ok = Boolean(s?.logged_in && exp && exp > new Date());
  if (ok) {
    el.className = "status ok";
    el.textContent = `Logged in${s.user_name ? " as " + s.user_name : ""} · valid until ${fmtTime(exp)} IST`;
  } else {
    el.className = "status err";
    el.textContent = s?.invalid_reason ? `Not logged in (${s.invalid_reason})` : "Not logged in";
  }
  return ok;
}

// After an approval request: check every 4 s (up to 3 min) and turn green by itself.
let approvalWatch = null;
function watchForApproval() {
  clearInterval(approvalWatch);
  const msg = $("upstox-request-msg");
  const started = Date.now();
  approvalWatch = setInterval(async () => {
    try {
      if (await loadUpstoxStatus()) {
        clearInterval(approvalWatch);
        msg.textContent = "✅ Approved — you're logged in.";
      } else if (Date.now() - started > 180_000) {
        clearInterval(approvalWatch);
        msg.textContent = "Still waiting for approval. Approve in the Upstox app / WhatsApp, or use Login to Upstox.";
      }
    } catch { /* network blip: try again on the next tick */ }
  }, 4000);
}

// Coming back to this tab (e.g. from WhatsApp) re-checks the login straight away.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && shownFor) loadUpstoxStatus().catch(() => {});
});

$("btn-upstox-request").onclick = async (ev) => {
  const msg = $("upstox-request-msg");
  ev.target.disabled = true;
  try {
    const r = await api("request_token");
    if (r.sent) {
      msg.textContent = "Sent. Open the Upstox app (or WhatsApp) and tap Approve — this page will update by itself.";
      watchForApproval();
    } else {
      msg.textContent = `Not sent: ${r.reason}.`;
    }
  } catch (e) {
    msg.textContent = "Could not send the request: " + e.message;
  } finally {
    ev.target.disabled = false;
  }
};

$("btn-upstox").onclick = async (ev) => {
  ev.target.disabled = true;
  try {
    location.href = (await api("login_url")).url;
  } catch (e) {
    alert("Could not start Upstox login: " + e.message);
    ev.target.disabled = false;
  }
};

// =====================================================================
// TODAY: levels
// =====================================================================
let currentLevels = null;

async function loadLevels(date) {
  let lv;
  if (date) {
    lv = lvFromRow(await one(sb.from("levels").select("*").eq("date", date)));
  } else {
    // Prefer today's levels; otherwise the newest (e.g. next session's, after 15:45).
    lv = lvFromRow(await one(sb.from("levels").select("*").eq("date", istToday())))
      ?? lvFromRow((await rows(sb.from("levels").select("*").not("p", "is", null).order("date", { ascending: false }).limit(1)))[0]);
  }
  currentLevels = lv;
  $("lv-date").value = lv?.date || date || istToday();
  if (!lv) {
    $("levels").innerHTML = `<p class="hint">No levels stored for ${esc(date || "any day")} yet. They are computed at 15:45 from the day's candle,
      or for every day you fetch on the Data tab.</p>`;
    $("lv-chart").innerHTML = ""; $("lv-legend").innerHTML = ""; $("chart-title").textContent = "Chart";
    return;
  }
  renderLevels(lv, await config("instruments"));
  loadLevelChart(lv);
}

async function stepLevels(dir) {
  const cur = $("lv-date").value || istToday();
  let q = sb.from("levels").select("date").not("p", "is", null);
  q = dir < 0 ? q.lt("date", cur).order("date", { ascending: false }) : q.gt("date", cur).order("date", { ascending: true });
  const r = await rows(q.limit(1));
  if (r.length) loadLevels(r[0].date);
}
$("btn-lv-prev").onclick = () => stepLevels(-1);
$("btn-lv-next").onclick = () => stepLevels(1);
$("lv-date").onchange = () => loadLevels($("lv-date").value);

function levelRows(lv) {
  // kind: res = resistance, sup = support, piv = pivot/CPR, ref = previous-day reference
  const rows = [
    ["R2", lv.R2, "res", "Resistance 2"], ["R1", lv.R1, "res", "Resistance 1"],
    ["PDH", lv.PDH, "ref", "Prev day high"],
    ["TC", lv.TC, "piv", "CPR top"], ["P", lv.P, "piv", "Pivot"], ["BC", lv.BC, "piv", "CPR bottom"],
    ["PDC", lv.PDC, "ref", "Prev day close"], ["PDL", lv.PDL, "ref", "Prev day low"],
    ["S1", lv.S1, "sup", "Support 1"], ["S2", lv.S2, "sup", "Support 2"],
  ];
  if (lv.maxCallOI != null) rows.push(["Call OI", lv.maxCallOI, "res", "Max call OI strike"]);
  if (lv.maxPutOI != null) rows.push(["Put OI", lv.maxPutOI, "sup", "Max put OI strike"]);
  return rows.sort((a, b) => b[1] - a[1]);
}

function renderLevels(lv, inst) {
  const isToday = lv.date === istToday();
  const nt = lv.no_trade;
  const ladder = levelRows(lv).map(([k, v, kind, label]) =>
    `<tr class="${["TC", "P", "BC"].includes(k) ? "cpr" : ""}"><td><span class="mark ${kind}"></span>${esc(k)}</td>
     <td class="mono">${num(v)}</td><td class="kind">${esc(label)}</td></tr>`).join("");

  const oi = lv.maxCallOI != null
    ? `<p>Resistance <b class="mono">${num(lv.maxCallOI)}</b> CE · OI ${num(lv.maxCallOI_oi, 0)}</p>
       <p>Support <b class="mono">${num(lv.maxPutOI)}</b> PE · OI ${num(lv.maxPutOI_oi, 0)}</p>
       <p class="hint">Expiry ${esc(lv.oi_expiry)} · spot ${num(lv.oi_spot)} · ${fmtTime(lv.oi_at)}<br>
         Top call OI: ${(lv.call_oi_top || []).map((r) => num(r.strike)).join(", ")} · Top put OI: ${(lv.put_oi_top || []).map((r) => num(r.strike)).join(", ")}</p>`
    : `<p class="hint">Filled at 09:20 on ${esc(fmtDay(lv.date))} from the option chain.</p>`;
  const instBox = inst && inst.for_date === lv.date
    ? `<div class="box"><h3>Contracts</h3>
        <p>Trade expiry <b>${esc(inst.trade_expiry)}</b>${inst.rolled_to_next ? " (rolled: expiry day / day before)" : ""}</p>
        <p>Lot size <b>${num(inst.lot_size, 0)}</b> · current expiry ${esc(inst.current_expiry)}</p></div>`
    : "";

  $("levels").innerHTML = `
    <p class="sub">For <b>${esc(fmtDay(lv.date))}</b>${isToday ? " (today)" : ""} · from ${esc(lv.based_on)}'s daily candle</p>
    <div class="grid2">
      <div><table class="ladder">${ladder}</table></div>
      <div>
        <div class="box"><h3>No-trade zone</h3>
          <p>Inside CPR: <b class="mono">${num(nt.cpr_low)} – ${num(nt.cpr_high)}</b> (width ${num(lv.cpr_width)})</p>
          <p>Near PDC (±${num(nt.pdc_band)}): <b class="mono">${num(nt.pdc_low)} – ${num(nt.pdc_high)}</b></p>
        </div>
        <div class="box"><h3>Option OI</h3>${oi}
          ${isToday ? `<button id="btn-oi">Refresh OI now</button>` : ""}</div>
        ${instBox}
      </div>
    </div>
    ${mathsBlock(lv)}`;
  if (isToday) $("btn-oi").onclick = refreshOI;
}

// Independent re-calculation in the browser so the owner can verify the stored numbers.
function mathsBlock(lv) {
  const H = lv.PDH, L = lv.PDL, C = lv.PDC;
  const r2 = (x) => Math.round(x * 100) / 100;
  const P = (H + L + C) / 3;
  let BC = (H + L) / 2, TC = 2 * P - BC;
  const swapped = BC > TC;
  if (swapped) [BC, TC] = [TC, BC];
  const calc = { P, BC, TC, R1: 2 * P - L, S1: 2 * P - H, R2: P + (H - L), S2: P - (H - L) };
  const ok = Object.entries(calc).every(([k, v]) => Math.abs(r2(v) - lv[k]) < 0.011);
  const f = (x) => r2(x).toFixed(2);
  return `<details class="maths"><summary>Check the maths ${ok ? '<span class="ok">✓ matches stored levels</span>' : '<span class="err">✗ differs from stored levels</span>'}</summary>
<pre>From ${esc(lv.based_on)}:  H = ${f(H)}   L = ${f(L)}   C = ${f(C)}   (H − L = ${f(H - L)})

P  = (H + L + C) / 3 = (${f(H)} + ${f(L)} + ${f(C)}) / 3 = ${f(P)}
BC = (H + L) / 2     = (${f(H)} + ${f(L)}) / 2 = ${f((H + L) / 2)}
TC = 2P − BC         = ${f(2 * P)} − ${f((H + L) / 2)} = ${f(2 * P - (H + L) / 2)}${swapped ? "\n     BC > TC, so they are swapped → CPR = " + f(BC) + " – " + f(TC) : ""}
R1 = 2P − L = ${f(2 * P)} − ${f(L)} = ${f(calc.R1)}
S1 = 2P − H = ${f(2 * P)} − ${f(H)} = ${f(calc.S1)}
R2 = P + (H − L) = ${f(P)} + ${f(H - L)} = ${f(calc.R2)}
S2 = P − (H − L) = ${f(P)} − ${f(H - L)} = ${f(calc.S2)}
No-trade near PDC = ${f(C)} ± ${lv.no_trade.pdc_band} = ${f(C - lv.no_trade.pdc_band)} – ${f(C + lv.no_trade.pdc_band)}</pre></details>`;
}

async function refreshOI(ev) {
  ev.target.disabled = true; ev.target.textContent = "Refreshing…";
  try {
    await api("refresh_premarket");
    await loadLevels(currentLevels?.date);
  } catch (e) {
    alert("OI refresh failed: " + e.message);
    ev.target.disabled = false; ev.target.textContent = "Refresh OI now";
  }
}

// ---------- levels chart
async function loadLevelChart(lv) {
  let candles = [], title = "";
  if (lv.date === istToday()) {
    try {
      candles = (await api("today_candles")).candles || [];
      if (candles.length) title = `Today 15-min (live, ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })})`;
    } catch (e) { console.warn("live candles unavailable:", e.message); }
  }
  if (!candles.length) {
    candles = (await one(sb.from("candles_15m").select("candles").eq("date", lv.based_on)))?.candles ?? [];
    title = `${fmtDay(lv.based_on)} 15-min (the day these levels come from)`;
  }
  $("chart-title").textContent = title;
  lastLevelChart = { candles, lv };
  drawLevelChart(candles, lv);
}

let lastLevelChart = null;
function drawLevelChart(candles, lv) {
  const { svg, offChart } = priceChart(candles, lv, $("lv-chart").clientWidth);
  $("lv-chart").innerHTML = svg;
  bindTooltips($("lv-chart"));
  $("lv-legend").innerHTML = `
    <span><span class="swatch" style="background:var(--down)"></span>Resistance (R, call OI)</span>
    <span><span class="swatch" style="background:var(--up)"></span>Support (S, put OI)</span>
    <span><span class="swatch" style="background:color-mix(in srgb,var(--accent) 30%,transparent)"></span>CPR</span>
    <span><span class="swatch" style="background:color-mix(in srgb,var(--warn) 25%,transparent)"></span>PDC ± band</span>
    <span>Hollow candle = up, filled = down</span>
    ${offChart.length ? `<span>Off chart: ${offChart.map(([k, v]) => `${esc(k)} ${num(v)}`).join(" · ")}</span>` : ""}`;
}
$("btn-live").onclick = () => currentLevels && loadLevelChart(currentLevels);

// Redraw at the new width after rotation / resize (text stays legible).
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastLevelChart && !$("tab-today").classList.contains("hidden")) drawLevelChart(lastLevelChart.candles, lastLevelChart.lv);
    if (!$("tab-data").classList.contains("hidden")) loadDay($("day").value);
  }, 150);
});

// Candles + optional level lines. Returns SVG markup and the levels that did not fit.
function priceChart(candles, lv, width = 720) {
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const [up, down, muted, accent, warn, card] = ["--up", "--down", "--muted", "--accent", "--warn", "--card"].map(col);
  // Draw at the real on-screen width so text stays 11px on phones.
  const W = Math.max(300, Math.round(width));
  const H = Math.round(Math.min(380, Math.max(260, W * 0.62)));
  const padL = 46, padR = lv ? 74 : 8, padT = 10, padB = 24;
  const labelEvery = W < 520 ? 8 : 4;

  let lo = candles.length ? Math.min(...candles.map((c) => c.l)) : (lv ? lv.S1 : 0);
  let hi = candles.length ? Math.max(...candles.map((c) => c.h)) : (lv ? lv.R1 : 1);
  const lines = lv ? levelRows(lv).map(([k, v, kind]) => ({ k, v, kind })) : [];
  const offChart = [];
  if (lv) {
    // Show levels close to the price action; list the far ones under the chart.
    const span = Math.max(hi - lo, 40);
    const wLo = lo - 0.6 * span, wHi = hi + 0.6 * span;
    for (const L of lines) {
      if (L.v >= wLo && L.v <= wHi) { lo = Math.min(lo, L.v); hi = Math.max(hi, L.v); } else { L.off = true; offChart.push([L.k, L.v]); }
    }
    lo = Math.min(lo, lv.no_trade.pdc_low); hi = Math.max(hi, lv.no_trade.pdc_high);
  }
  const pad = (hi - lo) * 0.04 || 5;
  lo -= pad; hi += pad;
  const y = (v) => padT + ((hi - v) / (hi - lo)) * (H - padT - padB);
  const plotR = W - padR;

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="15-minute candles${lv ? " with levels" : ""}">`;
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    s += `<line x1="${padL}" x2="${plotR}" y1="${y(v)}" y2="${y(v)}" stroke="${muted}" stroke-opacity=".15"/>`;
    s += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${muted}">${Math.round(v)}</text>`;
  }
  if (lv) {
    const nt = lv.no_trade;
    s += `<rect x="${padL}" y="${y(nt.pdc_high)}" width="${plotR - padL}" height="${y(nt.pdc_low) - y(nt.pdc_high)}" fill="${warn}" fill-opacity=".12"/>`;
    s += `<rect x="${padL}" y="${y(lv.TC)}" width="${plotR - padL}" height="${Math.max(1.5, y(lv.BC) - y(lv.TC))}" fill="${accent}" fill-opacity=".22"/>`;
    // labels: keep ≥12px apart
    const shown = lines.filter((L) => !L.off).map((L) => ({ ...L, ly: y(L.v) })).sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < shown.length; i++) if (shown[i].ly - shown[i - 1].ly < 12) shown[i].ly = shown[i - 1].ly + 12;
    for (const L of shown) {
      const stroke = { res: down, sup: up, piv: accent, ref: muted }[L.kind];
      const dash = L.kind === "ref" ? `stroke-dasharray="4 3"` : L.k.includes("OI") ? `stroke-dasharray="1 3"` : "";
      s += `<line x1="${padL}" x2="${plotR}" y1="${y(L.v)}" y2="${y(L.v)}" stroke="${stroke}" stroke-width="${L.kind === "piv" ? 1 : 1.5}" ${dash} stroke-opacity=".9"/>`;
      s += `<text x="${plotR + 4}" y="${L.ly + 4}" font-size="11" fill="${muted}">${esc(L.k)} ${Math.round(L.v)}</text>`;
    }
  }
  if (!candles.length) {
    s += `<text x="${(padL + plotR) / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="${muted}">No candles stored for this day</text>`;
    return { svg: s + "</svg>", offChart };
  }
  const step = (plotR - padL) / Math.max(candles.length, 25);
  const bw = Math.max(3, step * 0.62);
  let hits = "";
  candles.forEach((c, i) => {
    const x = padL + i * step + step / 2;
    const isUp = c.c >= c.o;
    const color = isUp ? up : down;
    const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
    s += `<line x1="${x}" x2="${x}" y1="${y(c.h)}" y2="${y(c.l)}" stroke="${color}" stroke-width="1.2"/>`;
    s += `<rect x="${x - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1, bot - top)}" rx="1"
            fill="${isUp ? card : color}" stroke="${color}" stroke-width="1.2"/>`;
    if (i % labelEvery === 0) s += `<text x="${x}" y="${H - 6}" text-anchor="middle" font-size="11" fill="${muted}">${c.t.slice(11, 16)}</text>`;
    const tip = `${c.t.slice(11, 16)}  O ${num(c.o)}  H ${num(c.h)}  L ${num(c.l)}  C ${num(c.c)}`;
    hits += `<rect class="hit" x="${padL + i * step}" y="${padT}" width="${step}" height="${H - padT - padB}" fill="transparent" data-tip="${esc(tip)}"/>`;
  });
  return { svg: s + hits + "</svg>", offChart };   // hit targets on top of everything
}

function bindTooltips(container) {
  const tip = $("tooltip");
  const show = (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (!t) { tip.classList.add("hidden"); return; }
    tip.textContent = t.dataset.tip;
    tip.classList.remove("hidden");
    const pt = e.touches ? e.touches[0] : e;
    const x = Math.min(pt.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, pt.clientY - tip.offsetHeight - 12)}px`;
  };
  container.onmousemove = show;
  container.ontouchstart = show;
  container.ontouchmove = show;
  container.onmouseleave = () => tip.classList.add("hidden");
  container.ontouchend = () => setTimeout(() => tip.classList.add("hidden"), 1500);
}

// =====================================================================
// DATA: backfill, day check, logs (Phase 1)
// =====================================================================
const MAX_DAYS_PER_CALL = 15; // the Edge Function's per-run limit; longer ranges are split here

$("bf-to").value = shiftDate(istToday(), -1);
$("bf-from").value = shiftDate(istToday(), -21);
$("btn-backfill").onclick = async (ev) => {
  const out = $("bf-result");
  const from = $("bf-from").value, to = $("bf-to").value;
  if (!from || !to || to < from) { out.innerHTML = `<p class="error">Pick a valid From/To range.</p>`; return; }
  ev.target.disabled = true;
  const days = [];
  try {
    for (let start = from; start <= to; start = shiftDate(start, MAX_DAYS_PER_CALL)) {
      const end = shiftDate(start, MAX_DAYS_PER_CALL - 1) < to ? shiftDate(start, MAX_DAYS_PER_CALL - 1) : to;
      out.innerHTML = `<p class="hint">Fetching ${esc(start)} → ${esc(end)}… (${days.length} day(s) done)</p>`;
      try {
        days.push(...(await api("backfill", { from: start, to: end })).days);
      } catch (e) {
        if (/Range is empty/.test(e.message)) break; // reached today before 15:31
        throw e;
      }
    }
    const cls = { ok: "ok", warn: "warn", error: "err" };
    out.innerHTML = `<p>${days.length} trading day(s) ${esc(from)} → ${esc(to)}</p>
      <div class="table-wrap"><table><tr><th>Date</th><th>Status</th><th>15m</th><th>1m</th><th>Daily</th><th>Levels for</th></tr>
      ${days.map((d) => `<tr><td><a href="#" data-day="${esc(d.date)}">${esc(d.date)}</a></td>
        <td class="${cls[d.status]}">${esc(d.status)}</td><td>${d.counts["15m"]}/${d.counts["15m_expected"]}</td>
        <td>${d.counts["1m"]}/${d.counts["1m_expected"]}</td><td>${d.counts.daily}</td><td>${esc(d.levels_for || "–")}</td></tr>`).join("")}
      </table></div>`;
    out.querySelectorAll("a[data-day]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); setDay(a.dataset.day); }));
    loadLogs();
  } catch (e) {
    out.innerHTML = `<p class="error">${esc(e.message)}</p>${days.length ? `<p class="hint">${days.length} day(s) were stored before the error.</p>` : ""}`;
  } finally {
    ev.target.disabled = false;
  }
};

$("day").value = shiftDate(istToday(), -1);
$("day").onchange = () => loadDay($("day").value);
$("btn-day-prev").onclick = () => setDay(shiftDate($("day").value, -1));
$("btn-day-next").onclick = () => setDay(shiftDate($("day").value, 1));
function setDay(d) { $("day").value = d; loadDay(d); }

async function loadDay(day) {
  const [r, c15] = await Promise.all([
    one(sb.from("data_checks").select("*").eq("date", day)),
    one(sb.from("candles_15m").select("candles").eq("date", day)),
  ]);
  const box = $("day-check");
  if (!r) {
    box.innerHTML = `<p class="hint">No data stored for ${esc(day)} (weekend/holiday, or not fetched yet).</p>`;
    $("chart").innerHTML = ""; $("tbl-15m").innerHTML = "";
    return;
  }
  const cls = { ok: "ok", warn: "warn", error: "err" }[r.status];
  const d = r.daily;
  box.innerHTML = `
    <div class="status ${cls}">${esc(r.status.toUpperCase())} · checked ${fmtTime(r.checked_at)}</div>
    <div class="kv">
      <div><span>15-min</span>${r.counts["15m"]}/${r.counts["15m_expected"]}</div>
      <div><span>1-min</span>${r.counts["1m"]}/${r.counts["1m_expected"]}</div>
      ${d ? `<div><span>Open</span>${d.o}</div><div><span>High</span>${d.h}</div>
             <div><span>Low</span>${d.l}</div><div><span>Close (official)</span>${d.c}</div>` : ""}
    </div>
    ${r.issues.length ? `<ul class="issues">${r.issues.map((i) => `<li class="${esc(i.severity)}">${esc(i.msg)}</li>`).join("")}</ul>` : ""}`;
  const candles = c15?.candles ?? [];
  $("chart").innerHTML = priceChart(candles, null, $("chart").clientWidth).svg;
  bindTooltips($("chart"));
  $("tbl-15m").innerHTML = `<tr><th>Time</th><th>Open</th><th>High</th><th>Low</th><th>Close</th></tr>` +
    candles.map((c) => `<tr><td>${esc(c.t.slice(11, 16))}</td><td>${c.o}</td><td>${c.h}</td><td>${c.l}</td><td>${c.c}</td></tr>`).join("");
}

async function loadLogs() {
  const logs = await rows(sb.from("logs").select("ts,job,level,message").order("id", { ascending: false }).limit(15));
  $("logs").innerHTML = logs.map((l) => {
    const cls = { error: "err", warn: "warn" }[l.level] || "";
    return `<li><div class="meta">${fmtTime(l.ts)} · ${esc(l.job)} · <span class="${cls}">${esc(l.level)}</span></div>${esc(l.message)}</li>`;
  }).join("") || `<li class="hint">No logs yet.</li>`;
}

// =====================================================================
// SIGNALS (Phase 3)
// =====================================================================
async function loadSignals() {
  const box = $("signals");
  try {
    const list = await rows(sb.from("signals").select("*").order("date", { ascending: false }).order("id", { ascending: false }).limit(60));
    if (!list.length) { box.innerHTML = `<p class="hint">No signals yet. The scan runs after every 15-min candle (09:31–15:16).</p>`; return; }
    const tone = { PENDING: "warn", TRIGGERED: "ok", CANCELLED: "", SKIPPED: "", TARGET: "ok", SL: "err", TIME_EXIT: "" };
    box.innerHTML = `<div class="table-wrap"><table class="signals">
      <tr><th>Date · candle</th><th>Status</th><th>Trade</th><th>Trigger</th><th>SL</th><th>Target</th><th>R</th><th>Lots · risk</th></tr>
      ${list.map((s) => `<tr>
        <td>${esc(fmtDay(s.date))}<br><span class="hint">${esc(s.b_time)} candle</span></td>
        <td><span class="pill ${tone[s.status] ?? ""}">${esc(s.status)}</span></td>
        <td>${s.strike ? `${num(s.strike, 0)} ${esc(s.side)}<br><span class="hint">${esc(s.expiry ?? "")}</span>` : esc(s.side)}</td>
        <td>${num(s.trigger)}</td><td>${num(s.sl)}</td><td>${num(s.target)}</td><td>${num(s.r)}</td>
        <td>${s.lots != null ? `${s.lots} · ₹${num(s.risk_rs, 0)}` : "–"}</td></tr>
        ${s.reason ? `<tr class="reason"><td colspan="8">${esc(s.reason)}</td></tr>` : ""}`).join("")}
    </table></div>`;
  } catch (e) {
    box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
$("btn-sig-refresh").onclick = loadSignals;

if (new URLSearchParams(location.search).get("upstox") === "ok") {
  history.replaceState(null, "", location.pathname);
}
