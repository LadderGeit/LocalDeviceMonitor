'use strict';

const api = window.deviceWatch;
const DAYS_SHOWN = 7;
const ALL = 'all';

const EVENT_TYPES = {
  ONLINE: { label: 'Came online', kind: 'online' },
  OFFLINE: { label: 'Went offline', kind: 'offline' },
  START: { label: 'Watching started', kind: 'watcher' },
  STOP: { label: 'Watching stopped', kind: 'watcher' },
  MOVED: { label: 'IP address changed', kind: 'moved' },
};

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'presence', label: 'Online & offline', test: (e) => e.type === 'ONLINE' || e.type === 'OFFLINE' },
  { id: 'watcher', label: 'Watching', test: (e) => e.type === 'START' || e.type === 'STOP' },
  { id: 'moved', label: 'IP changes', test: (e) => e.type === 'MOVED' },
];

// selected: ALL, or the MAC of the watched device the Summary and Log tabs show.
// busyUntil keeps the watcher's start/stop buttons disabled while it reacts to a click.
// pending: MACs with a change from the Devices tab still being saved.
const state = {
  data: null,
  model: null,
  selected: ALL,
  filter: 'all',
  query: '',
  startingUntil: 0,
  busyUntil: 0,
  pending: new Set(),
  scan: { devices: [], scanning: false, scannedAt: 0, error: null },
  renaming: null,
};
const stretchOf = new WeakMap();

const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const longDayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- Formatting ----------

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  // Past a day, minutes are noise.
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

// Midnight `back` days before today (0 = today, -1 = tomorrow). Counts calendar days, so a
// daylight-saving switch doesn't shift it.
function dayStart(now, back) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
}

function dayName(ms, now) {
  if (ms >= dayStart(now, 0)) return 'Today';
  if (ms >= dayStart(now, 1)) return 'Yesterday';
  return dayFormat.format(ms);
}

// "15:33", "yesterday 23:10" or "Thu 29 Oct 09:12".
function when(ms, now) {
  const day = dayName(ms, now);
  const time = timeFormat.format(ms);
  if (day === 'Today') return time;
  return `${day === 'Yesterday' ? 'yesterday' : day} ${time}`;
}

// "Yesterday 08:39 – 22:54", or with both days when the range crosses midnight.
function formatRange(start, end, now) {
  const sameDay = dayStart(start, 0) === dayStart(end, 0);
  return `${sentence(when(start, now))} – ${sameDay ? timeFormat.format(end) : when(end, now)}`;
}

function ago(ms, now) {
  return now - ms < 60000 ? 'just now' : `${formatDuration(now - ms)} ago`;
}

function sentence(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

function formatInterval(seconds) {
  if (seconds % 60) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return minutes === 1 ? 'minute' : `${minutes} minutes`;
}

// "Micro-Star INTL CO., LTD." reads better as "Micro-Star INTL".
function shortVendor(vendor) {
  return vendor ? vendor.replace(/[\s,]+(co\.?,?\s*)?(ltd|inc|corp|corporation|gmbh|llc|limited|plc)\.?\s*$/i, '') : '';
}

function ipValue(ip) {
  return ip.split('.').reduce((total, part) => total * 256 + Number(part), 0);
}

// Phones and tablets often use a made-up "private" address, marked by this bit.
function isRandomized(mac) {
  return (parseInt(mac.slice(0, 2), 16) & 2) !== 0;
}

// ---------- Data ----------

// Rebuilds a device's online/offline stretches from its events. Time between a STOP and the
// next START wasn't watched, so it belongs to no stretch.
function buildStretches(events, device, lastCheck, live, now) {
  const stretches = [];
  let open = null;
  let lastTime = null;
  const close = (end) => {
    if (open) stretches.push({ ...open, end: Math.max(open.start, end) });
    open = null;
  };

  for (const e of events) {
    const time = Date.parse(e.time);
    switch (e.type) {
      case 'START':
        close(lastTime ?? time);
        open = { online: Boolean(e.online), start: time };
        break;
      case 'ONLINE':
        close(time);
        open = { online: true, start: time };
        break;
      case 'OFFLINE': {
        const seen = Date.parse(e.lastSeen) || time;
        close(seen);
        open = { online: false, start: seen };
        break;
      }
      case 'STOP':
        close(e.online && e.lastSeen ? Date.parse(e.lastSeen) : time);
        break;
    }
    lastTime = time;
  }

  // The log was cleared while the watcher kept running, so no event marks the current stretch.
  if (!open && live && device) open = { online: Boolean(device.online), start: Date.parse(device.since) };

  if (open) {
    if (live) {
      open.ongoing = true;
      close(now);
    } else {
      close(Date.parse(open.online ? device?.lastSeen : lastCheck) || lastTime);
    }
  }
  return stretches;
}

function sumOverlap(stretches, from, to, online) {
  let total = 0;
  for (const s of stretches) {
    if (s.online === online) total += Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));
  }
  return total;
}

function watcherState(data, now) {
  const s = data.status;
  if (now < state.startingUntil && !data.watcherRunning) return { kind: 'warn', text: 'Starting the watcher…', starting: true };
  if (!s) return { kind: 'stopped', text: "Watcher hasn't run yet" };
  if (!data.watcherRunning) return { kind: 'stopped', text: 'Watcher is not running' };
  if (now - Date.parse(s.lastCheck) > (s.intervalSeconds * 2 + 120) * 1000) {
    return { kind: 'warn', text: 'Watcher is not responding' };
  }
  if (s.connected === false) return { kind: 'warn', text: "This PC isn't connected to a network" };
  const count = (data.config?.devices ?? []).filter((d) => d.watch).length;
  return { kind: 'ok', text: count ? `Watching ${count} device${count === 1 ? '' : 's'}` : 'Running, nothing to watch yet' };
}

// The public IPv4 address every device on the network shares, and the device's own public IPv6
// addresses: from the scan when it has them, else from what the dashboard last looked up.
function publicAddresses(mac, fromScan) {
  return {
    ipv4: state.data?.addresses?.publicIPv4 ?? null,
    ipv6: fromScan?.length ? fromScan : state.data?.addresses?.ipv6?.[mac] ?? [],
  };
}

// Everything the views need: each watched device with its status, events and stretches, and a
// way to name any device that appears in the log.
function buildModel(data, now) {
  const configured = data.config?.devices ?? [];
  const configOf = new Map(configured.map((d) => [d.mac, d]));
  const statusOf = new Map((data.status?.devices ?? []).map((d) => [d.mac, d]));
  const eventsOf = new Map();
  for (const e of data.events) {
    if (!eventsOf.has(e.mac)) eventsOf.set(e.mac, []);
    eventsOf.get(e.mac).push(e);
  }
  const nameOf = (mac) => configOf.get(mac)?.name || statusOf.get(mac)?.name || eventsOf.get(mac)?.at(-1)?.name || 'Unknown device';

  const watched = configured.filter((d) => d.watch).map((d) => {
    const status = statusOf.get(d.mac) ?? null;
    const events = eventsOf.get(d.mac) ?? [];
    const live = data.watcherRunning && Boolean(status);
    return {
      mac: d.mac,
      name: nameOf(d.mac),
      customName: d.name,
      vendor: status?.vendor ?? events.at(-1)?.vendor ?? null,
      hostname: status?.hostname ?? null,
      ip: status?.ip ?? d.ip,
      status,
      events,
      stretches: buildStretches(events, status, data.status?.lastCheck, live, now),
    };
  });
  return { watched, configOf, statusOf, eventsOf, nameOf };
}

// A watched device's state right now, worded for the sidebar, cards and tiles.
function deviceNow(device, watcher, now) {
  const s = device.status;
  if (!s || watcher.kind !== 'ok') {
    const checking = !s && (watcher.kind === 'ok' || watcher.starting);
    let text = 'Not being watched right now';
    if (checking) text = 'Waiting for the first check';
    else if (s && state.data?.status?.lastCheck) text = `Last checked ${when(Date.parse(state.data.status.lastCheck), now)}, when it was ${s.online ? 'online' : 'offline'}`;
    return { kind: 'unknown', label: checking ? 'Checking' : 'Unknown', short: checking ? 'Checking…' : 'Unknown', lead: 'Current state', text };
  }
  const since = Date.parse(s.since);
  const label = s.online ? 'Online' : 'Offline';
  const duration = formatDuration(now - since);
  return { kind: s.online ? 'online' : 'offline', label, short: `${label} · ${duration}`, lead: `${label} for${s.exact ? '' : ' at least'}`, duration, since };
}

function deviceStats(device, now) {
  const today = dayStart(now, 0);
  const weekStart = dayStart(now, DAYS_SHOWN - 1);
  const onToday = sumOverlap(device.stretches, today, now, true);
  const onWeek = sumOverlap(device.stretches, weekStart, now, true);
  return {
    onToday,
    watchedToday: onToday + sumOverlap(device.stretches, today, now, false),
    onWeek,
    watchedWeek: onWeek + sumOverlap(device.stretches, weekStart, now, false),
    longest: device.stretches.filter((s) => s.online).reduce((best, s) => (!best || s.end - s.start > best.end - best.start ? s : best), null),
  };
}

function selectedDevice() {
  return state.model?.watched.find((d) => d.mac === state.selected) ?? null;
}

// ---------- Rendering ----------

function render() {
  const data = state.data;
  if (!data) return;
  const now = Date.now();
  // Once the watcher is up, a later stop must read as stopped, not as still starting.
  if (data.watcherRunning) state.startingUntil = 0;
  const watcher = watcherState(data, now);
  const model = buildModel(data, now);
  state.model = model;
  if (state.selected !== ALL && !model.watched.some((d) => d.mac === state.selected)) state.selected = ALL;

  $('offline-banner').hidden = data.internet !== false;
  renderWatcherChip(data, watcher, now);
  renderSidebar(model, watcher, now);
  renderSummary(data, model, watcher, now);
  renderLog(data, model, now);
  renderDevices();

  const busy = now < state.busyUntil;
  for (const button of document.querySelectorAll('[data-action="start"]')) {
    button.hidden = data.watcherRunning;
    button.disabled = busy;
  }
  for (const button of document.querySelectorAll('[data-action="stop"]')) {
    button.hidden = !data.watcherRunning;
    button.disabled = busy;
  }
}

function statusPill(current) {
  return `<span class="status ${current.kind}"><span class="dot"></span>${escapeHtml(current.label)}</span>`;
}

function renderWatcherChip(data, watcher, now) {
  const chip = $('watcher-chip');
  chip.replaceChildren();
  const status = el('span', 'status');
  status.append(el('span', `dot ${watcher.kind}`), watcher.text);
  chip.append(status);
  if (watcher.kind === 'ok') {
    const next = Date.parse(data.status.lastCheck) + data.status.intervalSeconds * 1000;
    chip.append(el('span', null, `Next check ${timeFormat.format(Math.max(next, now))}`));
  }
}

function renderSidebar(model, watcher, now) {
  $('side-all').setAttribute('aria-current', String(state.selected === ALL));
  const online = model.watched.filter((d) => deviceNow(d, watcher, now).kind === 'online').length;
  $('side-all-sub').textContent = model.watched.length ? `${online} of ${model.watched.length} online` : 'Nothing watched yet';
  $('side-devices').innerHTML = model.watched.map((device) => {
    const current = deviceNow(device, watcher, now);
    return `<button type="button" class="side-item" data-select="${device.mac}" aria-current="${state.selected === device.mac}">
      <span class="side-mark"><span class="dot ${current.kind}"></span></span>
      <span class="side-text"><span class="side-name">${escapeHtml(device.name)}</span><span class="side-sub">${escapeHtml(current.short)}</span></span>
    </button>`;
  }).join('');
}

function renderSummary(data, model, watcher, now) {
  const nothing = model.watched.length === 0;
  $('summary-empty').hidden = !nothing;
  $('overview').hidden = nothing || state.selected !== ALL;
  $('detail').hidden = nothing || state.selected === ALL;
  if (nothing) return;
  if (state.selected === ALL) renderOverview(data, model, watcher, now);
  else renderDetail(selectedDevice(), watcher, now);
}

function renderOverview(data, model, watcher, now) {
  const online = model.watched.filter((d) => deviceNow(d, watcher, now).kind === 'online').length;
  $('overview-sub').textContent = `${model.watched.length} watched · ${watcher.kind === 'ok' ? `${online} online now` : watcher.text}`;

  $('device-cards').innerHTML = model.watched.map((device) => {
    const current = deviceNow(device, watcher, now);
    const stats = deviceStats(device, now);
    const today = stats.watchedToday ? `Today ${formatDuration(stats.onToday)} online` : 'Not watched today';
    const week = stats.watchedWeek ? ` · ${Math.round((stats.onWeek / stats.watchedWeek) * 100)}% this week` : '';
    return `<button type="button" class="device-card" data-select="${device.mac}">
      <span class="dc-top"><span class="dc-name">${escapeHtml(device.name)}</span>${statusPill(current)}</span>
      <span class="dc-label">${escapeHtml(current.duration ? current.lead : current.text)}</span>
      <span class="dc-value">${escapeHtml(current.duration ?? '—')}</span>
      <span class="dc-sub">${escapeHtml(today + week)}</span>
    </button>`;
  }).join('');

  const from = dayStart(now, 0);
  const to = dayStart(now, -1);
  renderTimeline($('today-timeline'), model.watched.map((d) => ({ label: d.name, stretches: d.stretches, from, to })), now);
  fillFacts('watcher-facts', watcherFacts(data, watcher, now));
}

function renderDetail(device, watcher, now) {
  $('device-name').textContent = device.name;
  $('device-sub').innerHTML = [[device.vendor, ''], [device.mac, 'mono'], [device.ip, 'mono']]
    .filter(([text]) => text)
    .map(([text, className]) => `<span class="${className}">${escapeHtml(text)}</span>`)
    .join('<span class="sep">·</span>');

  renderNowTile(device, watcher, now);
  const stats = deviceStats(device, now);
  fillTile('tile-today', 'Online today', stats.watchedToday ? formatDuration(stats.onToday) : '—',
    stats.watchedToday ? `of ${formatDuration(stats.watchedToday)} watched today` : 'Not watched today');
  fillTile('tile-week', 'Online, last 7 days', stats.watchedWeek ? `${Math.round((stats.onWeek / stats.watchedWeek) * 100)}%` : '—',
    stats.watchedWeek ? `${formatDuration(stats.onWeek)} of ${formatDuration(stats.watchedWeek)} watched` : 'Not watched yet');
  const longest = stats.longest;
  fillTile('tile-longest', 'Longest session', longest ? formatDuration(longest.end - longest.start) : '—',
    longest ? (longest.ongoing ? `Since ${when(longest.start, now)}, still online` : formatRange(longest.start, longest.end, now)) : 'No sessions yet');

  renderTimeline($('timeline'), Array.from({ length: DAYS_SHOWN }, (_, back) => ({
    label: back === 0 ? 'Today' : back === 1 ? 'Yesterday' : dayFormat.format(dayStart(now, back)),
    strong: back === 0,
    stretches: device.stretches,
    from: dayStart(now, back),
    to: dayStart(now, back - 1),
  })), now);

  const first = device.events[0] && Date.parse(device.events[0].time);
  const { ipv4, ipv6 } = publicAddresses(device.mac);
  const unknown = state.data?.internet === false ? "Unknown, can't be looked up offline" : 'Unknown';
  fillFacts('device-facts', [
    ['Name', device.name],
    ['Hostname', device.hostname || 'Not reported by the device', { className: device.hostname ? '' : 'dim' }],
    ['Manufacturer', device.vendor || unknown, { className: device.vendor ? '' : 'dim' }],
    ['MAC address', device.mac, { className: 'mono' }],
    ['Local IP', device.ip || '—', { className: 'mono' }],
    ['Public IPv4', ipv4 ? `${ipv4}, shared by your whole network` : unknown, { className: ipv4 ? '' : 'dim' }],
    ['Public IPv6', ipv6.length ? ipv6.join(', ') : 'None seen yet', { className: ipv6.length ? 'mono' : 'dim' }],
    ['First recorded', first ? `${dateFormat.format(first)}, ${timeFormat.format(first)}` : '—'],
  ]);

  $('activity').innerHTML = device.events.slice(-6).reverse().map((e) => {
    const info = EVENT_TYPES[e.type] ?? { label: e.type, kind: 'watcher' };
    return `<li>
      <span class="event ev-${info.kind}"><span class="dot"></span>${escapeHtml(info.label)}</span>
      <span class="activity-time">${escapeHtml(sentence(when(Date.parse(e.time), now)))}</span>
      <span class="activity-text">${escapeHtml(sentence(e.message))}</span>
    </li>`;
  }).join('') || '<li class="activity-empty">Nothing yet.</li>';
}

function renderNowTile(device, watcher, now) {
  const current = deviceNow(device, watcher, now);
  let sub = current.text;
  if (current.kind === 'online') sub = `Since ${when(current.since, now)}`;
  if (current.kind === 'offline') {
    sub = device.status.lastSeen ? `Last seen ${when(Date.parse(device.status.lastSeen), now)}` : 'Not seen since watching started';
  }
  $('tile-now').innerHTML = `
    <div class="top"><span class="label">${escapeHtml(current.lead)}</span>${statusPill(current)}</div>
    <div class="value">${escapeHtml(current.duration ?? 'Unknown')}</div>
    <div class="sub">${escapeHtml(sub)}</div>`;
}

function fillTile(id, label, value, sub) {
  $(id).innerHTML = `<div class="label">${escapeHtml(label)}</div>
    <div class="value">${escapeHtml(value)}</div>
    <div class="sub">${escapeHtml(sub)}</div>`;
}

// Draws timeline rows, each a track from `from` to `to` (a day) with the stretches on it, a
// label and the time online. The axis is shared.
function renderTimeline(root, rows, now) {
  root.replaceChildren();
  for (const row of rows) {
    const { from, to } = row;
    const until = Math.min(to, now);
    const pct = (ms) => ((ms - from) / (to - from)) * 100;

    const track = el('div', 'track');
    for (const g of [25, 50, 75]) track.append(el('span', `grid g${g}`));
    let online = 0;
    let watched = 0;
    for (const s of row.stretches) {
      const a = Math.max(s.start, from);
      const b = Math.min(s.end, until);
      if (b <= a) continue;
      watched += b - a;
      if (s.online) online += b - a;
      // A 1px inset on each side leaves a 2px gap between neighbouring stretches.
      const seg = el('span', `seg ${s.online ? 'on' : 'off'}`);
      seg.style.left = `calc(${pct(a)}% + 1px)`;
      seg.style.width = `max(2px, calc(${pct(b) - pct(a)}% - 2px))`;
      stretchOf.set(seg, s);
      track.append(seg);
    }
    if (now > from && now < to) {
      const future = el('span', 'future');
      future.style.left = `${pct(now)}%`;
      track.append(future);
    }

    const label = el('div', `tl-day${row.strong ? ' today' : ''}`, row.label);
    label.title = row.label;
    root.append(label, track, el('div', 'tl-total', watched ? formatDuration(online) : '—'));
  }

  const axis = el('div', 'tl-axis');
  for (const [cls, text] of [['a0', '00:00'], ['a25', '06:00'], ['a50', '12:00'], ['a75', '18:00'], ['a100', '24:00']]) {
    axis.append(el('span', cls, text));
  }
  root.append(el('div'), axis, el('div'));
}

function fillFacts(id, rows) {
  const list = $(id);
  list.replaceChildren();
  for (const [term, value, options = {}] of rows) {
    const dd = el('dd', options.className);
    if (options.dot) dd.append(el('span', `dot ${options.dot}`));
    dd.append(value);
    list.append(el('dt', null, term), dd);
  }
}

function watcherFacts(data, watcher, now) {
  const s = data.status;
  const lastCheck = s && Date.parse(s.lastCheck);
  const running = watcher.kind === 'ok';
  return [
    ['Status', watcher.text, { dot: watcher.kind }],
    ['Checks', s ? `Every ${formatInterval(s.intervalSeconds)}` : '—'],
    ['Last check', lastCheck ? `${when(lastCheck, now)} (${ago(lastCheck, now)})` : '—'],
    ['Next check', running ? when(Math.max(lastCheck + s.intervalSeconds * 1000, now), now) : '—'],
    ['Running since', data.watcherRunning && s?.watcherStarted ? when(Date.parse(s.watcherStarted), now) : '—'],
  ];
}

function renderLog(data, model, now) {
  const device = selectedDevice();
  const events = device ? device.events : data.events;
  $('log-count').textContent = events.length || '';
  $('log-title').textContent = device ? device.name : 'All devices';
  $('log-sub').textContent = device ? `Saved in logs\\${device.mac}.txt` : "Every device's events, including devices you no longer watch";
  $('open-log-button').textContent = device ? 'Open log file' : 'Open logs folder';
  $('clear-button').textContent = device ? 'Clear log' : 'Clear all logs';
  $('clear-button').disabled = events.length === 0;
  $('log-table').classList.toggle('single', Boolean(device));

  for (const button of $('log-filters').children) {
    const filter = FILTERS.find((f) => f.id === button.dataset.filter);
    button.setAttribute('aria-pressed', String(filter.id === state.filter));
    button.querySelector('.n').textContent = events.filter(filter.test).length;
  }

  const filter = FILTERS.find((f) => f.id === state.filter);
  const query = state.query.trim().toLowerCase();
  const rows = events
    .filter(filter.test)
    .filter((e) => !query || [e.message, model.nameOf(e.mac), e.mac, e.ip, e.vendor, e.hostname, EVENT_TYPES[e.type]?.label]
      .some((v) => v && String(v).toLowerCase().includes(query)))
    .reverse();

  let html = '';
  let currentDay = null;
  for (const e of rows) {
    const time = Date.parse(e.time);
    const day = dayStart(time, 0);
    if (day !== currentDay) {
      currentDay = day;
      const name = dayName(time, now);
      const label = name === 'Today' || name === 'Yesterday' ? `${name} · ${longDayFormat.format(time)}` : longDayFormat.format(time);
      html += `<tr class="day"><th colspan="5" scope="colgroup">${escapeHtml(label)}</th></tr>`;
    }
    const info = EVENT_TYPES[e.type] ?? { label: e.type, kind: 'watcher' };
    html += `<tr>
      <td class="time">${timeFormat.format(time)}</td>
      <td><span class="event ev-${info.kind}"><span class="dot"></span>${escapeHtml(info.label)}</span></td>
      <td class="col-device"><div>${escapeHtml(model.nameOf(e.mac))}</div><div class="mac mono">${escapeHtml(e.mac)}</div></td>
      <td>${escapeHtml(sentence(e.message))}</td>
      <td class="ip">${escapeHtml(e.ip)}</td>
    </tr>`;
  }
  $('log-body').innerHTML = html;

  const empty = $('log-empty');
  empty.hidden = rows.length > 0;
  empty.textContent = events.length ? 'No events match.' : 'No events yet. They show up here as soon as the watcher logs something.';
}

// ---------- Devices tab ----------

const PENCIL = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5l2 2L6 12l-2.8.8L4 10z"/></svg>';

// Every device from the last scan, plus named or watched ones the scan didn't find (offline, say).
function deviceRows() {
  const model = state.model;
  const rows = state.scan.devices.map((d) => ({ ...d, seen: true }));
  for (const config of model?.configOf.values() ?? []) {
    if (rows.some((r) => r.mac === config.mac)) continue;
    const status = model.statusOf.get(config.mac);
    const ip = status?.ip ?? config.ip;
    rows.push({
      mac: config.mac,
      ip,
      ips: [ip],
      hostname: status?.hostname ?? null,
      vendor: status?.vendor ?? model.eventsOf.get(config.mac)?.at(-1)?.vendor ?? '',
      randomized: isRandomized(config.mac),
      seen: false,
    });
  }
  return rows.sort((a, b) => ipValue(a.ip) - ipValue(b.ip));
}

function renderDevices() {
  const { scanning, scannedAt, error } = state.scan;
  const rows = deviceRows();
  const configOf = state.model?.configOf ?? new Map();

  const button = $('scan-button');
  button.disabled = scanning;
  button.textContent = scanning ? 'Scanning…' : scannedAt ? 'Scan again' : 'Scan network';

  let note = 'Finds every device on your network that is online right now.';
  if (scanning) note = 'Checking every address on your network. This takes about 15 seconds.';
  else if (error) note = `The scan didn't work: ${error}`;
  else if (scannedAt) {
    const found = state.scan.devices.length;
    note = `${found} device${found === 1 ? '' : 's'} answered at ${timeFormat.format(scannedAt)}. Watch as many as you like, and rename any of them.`;
  }
  $('scan-note').textContent = note;
  const ipv4 = state.data?.addresses?.publicIPv4;
  const offline = state.data?.internet === false;
  if (ipv4) {
    $('public-note').textContent = `All of them share the public IPv4 address ${ipv4}, your modem's. Public IPv6 addresses are each device's own, listed where Windows has seen them.`;
  } else {
    $('public-note').textContent = offline ? "Your public IP can't be looked up without an internet connection." : '';
  }

  $('devices-body').innerHTML = rows.map((device) => {
    const config = configOf.get(device.mac);
    const name = config?.name || device.hostname;
    const tags = [
      device.isSelf && ['This PC', ''],
      device.isGateway && ['Gateway', 'Your PC reaches the internet through this device'],
      device.randomized && ['Private address', 'The device hides its real MAC address on this network'],
      !device.seen && ['Not seen in this scan', ''],
    ].filter(Boolean);
    let vendor;
    if (device.randomized) vendor = '<span class="dim">Hidden by the device</span>';
    else if (device.vendor === undefined && offline) vendor = '<span class="dim">Unavailable offline</span>';
    else if (device.vendor === undefined) vendor = '<span class="dim">Looking up…</span>';
    else vendor = device.vendor ? escapeHtml(device.vendor) : '<span class="dim">Unknown</span>';

    let action = '';
    if (state.pending.has(device.mac)) action = '<span class="dim">Saving…</span>';
    else if (config?.watch) action = `<span class="badge">Watching</span><button type="button" class="btn small stop" data-unwatch="${device.mac}">Stop</button>`;
    else if (!device.isSelf) action = `<button type="button" class="btn small go" data-watch="${device.mac}">Watch</button>`;

    return `<tr${config?.watch ? ' class="current"' : ''}>
      <td>
        <div class="name-cell">
          ${name ? `<span>${escapeHtml(name)}</span>` : '<span class="dim">No name</span>'}
          <button type="button" class="icon-btn" data-rename="${device.mac}" aria-label="Rename ${escapeHtml(name || device.mac)}" title="Rename">${PENCIL}</button>
        </div>
        ${tags.length ? `<div class="tags">${tags.map(([tag, title]) => `<span class="tag"${title ? ` title="${escapeHtml(title)}"` : ''}>${tag}</span>`).join('')}</div>` : ''}
      </td>
      <td>${vendor}</td>
      <td class="ip">${device.ips.map(escapeHtml).join('<br>')}</td>
      <td class="public">${publicCell(device)}</td>
      <td class="mono">${escapeHtml(device.mac)}</td>
      <td class="action">${action}</td>
    </tr>`;
  }).join('');

  const empty = $('devices-empty');
  empty.hidden = rows.length > 0;
  if (scanning) empty.textContent = 'Scanning…';
  else if (scannedAt) empty.textContent = 'No devices answered. Check that this PC is connected, then scan again.';
  else empty.textContent = 'No scan yet.';
}

function publicCell(device) {
  const { ipv4, ipv6 } = publicAddresses(device.mac, device.ipv6);
  const lines = ipv4 ? [`<div>${escapeHtml(ipv4)}</div>`] : [];
  for (const address of ipv6) lines.push(`<div class="v6 mono">${escapeHtml(address)}</div>`);
  return lines.join('') || '<span class="dim">—</span>';
}

async function scan() {
  if (state.scan.scanning) return;
  state.scan.scanning = true;
  state.scan.error = null;
  renderDevices();
  try {
    state.scan.devices = await api.scanNetwork();
    state.scan.scannedAt = Date.now();
  } catch (error) {
    state.scan.error = String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  state.scan.scanning = false;
  renderDevices();
}

async function updateDevice(change) {
  // Watching a device starts the watcher when it isn't running.
  if (change.watch && !state.data?.watcherRunning) state.startingUntil = Date.now() + 30000;
  state.pending.add(change.mac);
  renderDevices();
  try {
    await api.updateDevice(change);
  } finally {
    state.pending.delete(change.mac);
    await refresh();
  }
}

function openRename(mac) {
  const row = deviceRows().find((d) => d.mac === mac);
  const config = state.model?.configOf.get(mac);
  const watched = state.model?.watched.find((d) => d.mac === mac);
  state.renaming = { mac, ip: config?.ip ?? row?.ip ?? watched?.ip };
  $('rename-mac').textContent = mac;
  const input = $('rename-input');
  input.value = config?.name ?? '';
  input.placeholder = row?.hostname || watched?.hostname || shortVendor(row?.vendor || watched?.vendor) || 'Unknown device';
  $('rename-dialog').returnValue = '';
  $('rename-dialog').showModal();
  input.select();
}

// ---------- Interaction ----------

function showTab(id) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.dataset.tab === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`view-${tab.dataset.tab}`).hidden = !selected;
  }
  document.body.dataset.tab = id;
  if (id === 'devices' && !state.scan.scannedAt) scan();
  remember('tab', id);
}

function select(mac) {
  state.selected = mac;
  remember('selected', mac);
  render();
}

// Remembering the tab and device is a nicety; nothing breaks without storage.
function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // See above.
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setUpTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      showTab(next.dataset.tab);
      next.focus();
    });
  }
  state.selected = recall('selected') || ALL;
  const saved = recall('tab');
  if (saved && $(`view-${saved}`)) showTab(saved);
}

// theme.js has already applied the saved theme; this keeps the dark mode switch in step with it.
function setUpThemeToggle() {
  const root = document.documentElement;
  const toggle = $('theme-toggle');
  const sync = () => {
    const dark = root.dataset.theme !== 'light';
    toggle.setAttribute('aria-checked', String(dark));
    toggle.title = dark ? 'Dark mode is on' : 'Dark mode is off';
  };
  sync();
  toggle.addEventListener('click', () => {
    if (root.dataset.theme === 'light') delete root.dataset.theme;
    else root.dataset.theme = 'light';
    remember('theme', root.dataset.theme === 'light' ? 'light' : 'dark');
    sync();
  });
}

function setUpLogControls() {
  const bar = $('log-filters');
  for (const filter of FILTERS) {
    const button = el('button', null, filter.label);
    button.type = 'button';
    button.dataset.filter = filter.id;
    button.append(el('span', 'n'));
    button.addEventListener('click', () => {
      state.filter = filter.id;
      render();
    });
    bar.append(button);
  }
  $('log-search').addEventListener('input', (event) => {
    state.query = event.target.value;
    render();
  });
}

function setUpTooltip() {
  const tooltip = $('tooltip');
  for (const timeline of document.querySelectorAll('.timeline')) {
    timeline.addEventListener('mousemove', (event) => {
      const stretch = stretchOf.get(event.target);
      if (!stretch) {
        tooltip.hidden = true;
        return;
      }
      const now = Date.now();
      const range = stretch.ongoing
        ? `Since ${when(stretch.start, now)} · ${formatDuration(now - stretch.start)} so far`
        : `${formatRange(stretch.start, stretch.end, now)} · ${formatDuration(stretch.end - stretch.start)}`;
      tooltip.innerHTML = `<strong>${stretch.online ? 'Online' : 'Offline'}</strong>${escapeHtml(range)}`;
      tooltip.hidden = false;
      const x = Math.min(event.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
      const y = event.clientY + 16 + tooltip.offsetHeight > window.innerHeight ? event.clientY - tooltip.offsetHeight - 10 : event.clientY + 16;
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${y}px`;
    });
    timeline.addEventListener('mouseleave', () => {
      tooltip.hidden = true;
    });
  }
}

function setUpActions() {
  document.addEventListener('click', (event) => {
    const selectButton = event.target.closest('[data-select]');
    if (selectButton) {
      select(selectButton.dataset.select);
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const device = selectedDevice();
    switch (button.dataset.action) {
      case 'log':
        api.openLog(device?.mac ?? null);
        break;
      case 'logs':
        api.openLog(null);
        break;
      case 'folder':
        api.openFolder();
        break;
      case 'devices':
        showTab('devices');
        break;
      case 'show-log':
        showTab('log');
        break;
      case 'rename':
        if (device) openRename(device.mac);
        break;
      case 'unwatch':
        if (device) updateDevice({ mac: device.mac, watch: false });
        break;
      case 'start':
        state.startingUntil = Date.now() + 20000;
        state.busyUntil = state.startingUntil;
        api.startWatcher();
        render();
        setTimeout(refresh, 20000);
        break;
      case 'stop':
        state.busyUntil = Date.now() + 15000;
        render();
        api.stopWatcher().then(() => {
          state.busyUntil = 0;
          refresh();
        });
        break;
      case 'clear': {
        const count = (device ? device.events : state.data?.events ?? []).length;
        const whose = device ? `of ${device.name}, from its log file` : 'of every device, from all log files';
        $('clear-text').textContent = `This deletes all ${count} event${count === 1 ? '' : 's'} ${whose} and the dashboard. It can't be undone.`;
        $('clear-confirm').textContent = device ? 'Clear log' : 'Clear all logs';
        $('clear-dialog').returnValue = '';
        $('clear-dialog').showModal();
        break;
      }
    }
  });

  $('clear-dialog').addEventListener('close', async () => {
    if ($('clear-dialog').returnValue !== 'clear') return;
    await api.clearLog(selectedDevice()?.mac ?? null);
    refresh();
  });

  $('rename-dialog').addEventListener('close', () => {
    const renaming = state.renaming;
    state.renaming = null;
    if ($('rename-dialog').returnValue !== 'save' || !renaming) return;
    updateDevice({ mac: renaming.mac, ip: renaming.ip, name: $('rename-input').value });
  });

  $('scan-button').addEventListener('click', scan);
  $('devices-body').addEventListener('click', (event) => {
    const watch = event.target.closest('[data-watch]');
    const unwatch = event.target.closest('[data-unwatch]');
    const rename = event.target.closest('[data-rename]');
    if (watch) {
      const row = deviceRows().find((d) => d.mac === watch.dataset.watch);
      updateDevice({ mac: row.mac, ip: row.ip, watch: true });
    }
    if (unwatch) updateDevice({ mac: unwatch.dataset.unwatch, watch: false });
    if (rename) openRename(rename.dataset.rename);
  });

  api.onVendor(({ prefix, vendor }) => {
    for (const device of state.scan.devices) {
      if (!device.randomized && device.mac.startsWith(prefix)) device.vendor = vendor;
    }
    renderDevices();
  });
}

async function refresh() {
  try {
    state.data = await api.getData();
  } catch {
    return;
  }
  render();
}

setUpTabs();
setUpThemeToggle();
setUpLogControls();
setUpTooltip();
setUpActions();
api.onChange(refresh);
// Also refresh on a timer: it keeps the durations current and notices a watcher that
// stopped without writing anything.
setInterval(refresh, 30000);
refresh();
