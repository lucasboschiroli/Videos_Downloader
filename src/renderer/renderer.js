const $ = (id) => document.getElementById(id);

const state = {
    settings: null,
    groups: [],         // one per added link: { id, source, title, channel, isPlaylist, total, items: [...] }
    downloading: false,
    stopRequested: false,
    run: null,          // { done, ok, failed, skipped, outDir }
    loading: 0,         // links currently being read
    nextKey: 1,
};

// ---------------------------------------------------------------- helpers
function fmtDuration(s) {
    if (!s) return '';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = h ? String(m).padStart(2, '0') : m;
    return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

function fmtTotal(s) {
    if (!s) return '';
    if (s < 60) return `${Math.round(s)} sec`;
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h} h ${m} min` : `${m} min`;
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function show(section) {
    for (const id of ['emptyState', 'loadingState', 'errorState', 'queue']) {
        $(id).classList.toggle('hidden', id !== section);
    }
}

function saveSetting(patch) {
    Object.assign(state.settings, patch);
    window.api.setSettings(patch);
}

// --------------------------------------------------------------- titlebar
$('winMinimize').onclick = () => window.api.minimize();
$('winMaximize').onclick = () => window.api.maximize();
$('winClose').onclick = () => window.api.close();
window.api.onMaximized((max) => {
    $('winMaximize').innerHTML = max ? '&#10697;' : '&#9633;';
    $('winMaximize').title = max ? 'Restore' : 'Maximize';
});

// ---------------------------------------------------------------- options
function bindSeg(segId, key, onChange) {
    const seg = $(segId);
    const paint = () => seg.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', b.dataset.value === state.settings[key]));
    seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || state.downloading) return;
        saveSetting({ [key]: b.dataset.value });
        paint();
        onChange && onChange();
    });
    paint();
}

function paintMode() {
    const audio = state.settings.mode === 'audio';
    $('qualitySeg').classList.toggle('disabled', audio);
    $('subsOpt').classList.toggle('disabled', audio);
    $('subsOpt').title = audio ? 'Subtitles are only added to videos' : '';
    document.querySelector('.subs-row').classList.toggle('subs-off', !state.settings.subs);
}

function paintFolder() {
    $('folderBtn').textContent = state.settings.outDir;
    $('folderBtn').title = state.settings.outDir;
}

async function initOptions() {
    state.settings = await window.api.getSettings();
    bindSeg('modeSeg', 'mode', paintMode);
    bindSeg('qualitySeg', 'quality');
    paintMode();
    paintFolder();

    $('browserSelect').value = state.settings.browser;
    $('browserSelect').onchange = (e) => saveSetting({ browser: e.target.value });
    $('subfolderChk').checked = state.settings.subfolder;
    $('subfolderChk').onchange = (e) => saveSetting({ subfolder: e.target.checked });
    $('numberChk').checked = state.settings.number;
    $('numberChk').onchange = (e) => saveSetting({ number: e.target.checked });
    $('subsChk').checked = state.settings.subs;
    $('subsChk').onchange = (e) => { saveSetting({ subs: e.target.checked }); paintMode(); };
    $('subLangsInput').value = state.settings.subLangs;
    $('subLangsInput').onchange = (e) => {
        const v = e.target.value.trim() || 'en';
        e.target.value = v;
        saveSetting({ subLangs: v });
    };
    $('autoSubsChk').checked = state.settings.autoSubs;
    $('autoSubsChk').onchange = (e) => saveSetting({ autoSubs: e.target.checked });

    $('folderBtn').onclick = async () => {
        const dir = await window.api.pickFolder(state.settings.outDir);
        if (dir) { saveSetting({ outDir: dir }); paintFolder(); }
    };
    $('openFolderBtn').onclick = () => window.api.openFolder(state.settings.outDir);
}

async function initTools() {
    const t = await window.api.toolStatus();
    const badge = $('toolBadge');
    if (!t.ytdlp) {
        badge.textContent = 'yt-dlp missing';
        badge.classList.add('bad');
        badge.title = 'Install it with: pip install yt-dlp';
    } else if (!t.ffmpeg) {
        badge.textContent = 'ffmpeg missing';
        badge.classList.add('bad');
        badge.title = 'Without ffmpeg, MP3 conversion and HD video merging won\'t work. Install it with: winget install ffmpeg';
    } else {
        badge.textContent = 'Ready';
        badge.title = `${t.ytdlp}\nffmpeg: ${t.ffmpeg}`;
    }
}

// ------------------------------------------------------------------ queue
const TRASH = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
const ACTIVE = ['starting', 'downloading', 'processing'];
const allItems = () => state.groups.flatMap((g) => g.items);
const findItem = (key) => allItems().find((it) => it.key === key);
const groupOf = (it) => state.groups.find((g) => g.items.includes(it));
const isActive = (it) => ACTIVE.includes(it.status);
const canQueue = (it) => it.checked && !it.unavailable && it.status !== 'done' && !isActive(it);

// The queue survives closing the app (progress and errors are not kept).
function saveQueue() {
    try {
        const slim = state.groups.map((g) => ({ ...g, items: g.items.map((it) => ({
            key: it.key, index: it.index, id: it.id, url: it.url, mediaUrl: it.mediaUrl, referer: it.referer,
            title: it.title, duration: it.duration, channel: it.channel, thumbnail: it.thumbnail,
            unavailable: it.unavailable, checked: it.checked, done: it.status === 'done',
        })) }));
        window.api.saveQueue(slim);
    } catch { /* the queue just won't be remembered */ }
}

async function restoreQueue() {
    try {
        const groups = await window.api.loadQueue();
        for (const g of groups) {
            for (const it of g.items) {
                Object.assign(it, it.unavailable ? { status: 'unavailable', label: 'Unavailable' }
                    : it.done ? { status: 'done', label: 'Done' } : { status: 'waiting', label: 'Waiting' });
                delete it.done;
                state.nextKey = Math.max(state.nextKey, Number(it.key) + 1);
            }
            state.nextKey = Math.max(state.nextKey, Number(g.id) + 1);
        }
        state.groups = groups.filter((g) => g.items.length);
    } catch {
        state.groups = [];
    }
}

// ------------------------------------------------------------------- load
$('pasteBtn').onclick = async () => {
    try {
        $('linkInput').value = (await navigator.clipboard.readText()).trim();
        $('linkInput').focus();
    } catch { /* clipboard blocked */ }
};

function cleanError(err) {
    return String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function paintLoading() {
    const empty = !state.groups.length;
    if (empty) {
        show(state.loading ? 'loadingState' : 'emptyState');
    } else {
        show('queue');
        $('pendingLoad').classList.toggle('hidden', !state.loading);
        $('pendingText').textContent = state.loading > 1 ? `Reading ${state.loading} links…` : 'Reading link…';
    }
}

function showLoadError(message) {
    if (!state.groups.length) {
        $('errorText').textContent = message;
        show('errorState');
    } else {
        $('loadErrorText').textContent = `Couldn't add that link: ${message}`;
        $('loadError').classList.remove('hidden');
    }
}
$('loadErrorClose').onclick = () => $('loadError').classList.add('hidden');

$('linkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('linkInput').value.trim();
    if (!url) return;
    $('loadError').classList.add('hidden');

    if (state.groups.some((g) => g.source === url)) {
        showLoadError('it is already in the queue.');
        return;
    }

    $('linkInput').value = '';
    state.loading++;
    paintLoading();
    try {
        const pl = await window.api.loadPlaylist(url, state.settings.browser);
        const group = {
            id: String(state.nextKey++), source: url, title: pl.title, channel: pl.channel,
            isPlaylist: pl.isPlaylist, total: pl.items.length, items: [],
        };
        group.items = pl.items.map((it, i) => ({
            ...it, key: String(state.nextKey++), index: i + 1, checked: !it.unavailable,
            // Added while downloading: it joins the running queue straight away.
            status: it.unavailable ? 'unavailable' : state.downloading ? 'queued' : 'waiting',
            label: it.unavailable ? 'Unavailable' : state.downloading ? 'Queued' : 'Waiting',
        }));
        state.groups.push(group);
        saveQueue();
        renderQueue();
        $(`group-${group.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (err) {
        if (!url.includes(' ')) $('linkInput').value = $('linkInput').value || url;
        showLoadError(cleanError(err));
    } finally {
        state.loading--;
        paintLoading();
    }
});

// ----------------------------------------------------------------- render
function renderQueue() {
    paintLoading();
    const box = $('groups');
    box.innerHTML = '';
    for (const g of state.groups) box.appendChild(renderGroup(g));
    updateSelection();
}

function renderGroup(g) {
    const card = el('section', 'group card');
    card.id = `group-${g.id}`;

    const head = el('div', 'group-head');
    const check = el('label', 'group-check');
    const box = el('input');
    box.type = 'checkbox';
    box.title = 'Select or unselect every video in this group';
    box.onchange = () => {
        for (const it of g.items) if (!it.unavailable && it.status !== 'done' && !isActive(it)) setChecked(it, box.checked);
        saveQueue();
        updateSelection();
    };
    check.appendChild(box);

    const title = el('div', 'group-title');
    const total = g.items.reduce((s, it) => s + (it.duration || 0), 0);
    title.append(el('h3', null, g.title),
        el('p', null, [g.channel, `${g.items.length} ${g.items.length === 1 ? 'video' : 'videos'}`, fmtTotal(total)].filter(Boolean).join('  ·  ')));

    const trash = el('button', 'remove-btn');
    trash.innerHTML = TRASH;
    trash.title = 'Remove this group from the queue';
    trash.onclick = () => removeGroup(g);

    head.append(check, title, trash);
    const list = el('ol', 'items');
    for (const it of g.items) list.appendChild(renderItem(it));
    card.append(head, list);
    return card;
}

function renderItem(it) {
    const li = el('li', 'item');
    li.id = `item-${it.key}`;

    const check = el('label', 'item-check');
    const box = el('input');
    box.type = 'checkbox';
    box.onchange = () => { setChecked(it, box.checked); saveQueue(); updateSelection(); };
    check.appendChild(box);

    const idx = el('span', 'item-index', it.index);

    const thumb = el('div', 'thumb');
    if (it.thumbnail) {
        const img = el('img');
        img.src = it.thumbnail;
        img.loading = 'lazy';
        img.alt = '';
        img.onerror = () => img.remove();
        thumb.appendChild(img);
    }
    if (it.duration) thumb.appendChild(el('span', 'dur', fmtDuration(it.duration)));

    const body = el('div', 'item-body');
    const title = el('div', 'item-title', it.title);
    title.title = 'Open in your browser';
    title.onclick = () => window.api.openLink(it.url);
    const sub = el('div', 'item-sub', it.channel || '');
    const bar = el('div', 'bar hidden');
    bar.appendChild(el('div', 'bar-fill'));
    body.append(title, sub, bar);

    const status = el('span', 'status');
    const trash = el('button', 'remove-btn');
    trash.innerHTML = TRASH;
    trash.title = 'Remove from the queue';
    trash.onclick = () => removeItem(it);

    li.append(check, idx, thumb, body, status, trash);
    paintItem(it, li);
    return li;
}

function statusClass(s) {
    return { starting: 'active', downloading: 'active', processing: 'active', queued: 'queued', done: 'done', error: 'error', cancelled: 'cancelled' }[s] || '';
}

function paintItem(it, li = $(`item-${it.key}`)) {
    if (!li) return;
    const active = isActive(it);
    li.classList.toggle('unchecked', !it.checked && it.status !== 'done');
    li.classList.toggle('active', active);
    const status = li.querySelector('.status');
    status.className = `status ${statusClass(it.status)}`;
    status.textContent = it.label;

    const box = li.querySelector('.item-check input');
    box.checked = it.checked;
    box.disabled = !!it.unavailable || active || it.status === 'done';
    li.querySelector('.remove-btn').disabled = active;

    const sub = li.querySelector('.item-sub');
    if (it.status === 'error') {
        sub.textContent = it.error || 'Download failed';
        sub.classList.add('err');
    } else if (it.status === 'downloading') {
        sub.textContent = [it.speed, it.eta && `${it.eta} left`].filter(Boolean).join('  ·  ');
        sub.classList.remove('err');
    } else {
        sub.textContent = it.channel || '';
        sub.classList.remove('err');
    }

    const bar = li.querySelector('.bar');
    bar.classList.toggle('hidden', !['downloading', 'processing'].includes(it.status));
    bar.firstChild.style.width = `${it.status === 'processing' ? 100 : (it.percent || 0)}%`;
}

function paintGroupHead(g) {
    const card = $(`group-${g.id}`);
    if (!card) return;
    const pickable = g.items.filter((it) => !it.unavailable && it.status !== 'done');
    const box = card.querySelector('.group-check input');
    box.checked = pickable.length > 0 && pickable.every((it) => it.checked);
    box.indeterminate = !box.checked && pickable.some((it) => it.checked);
    box.disabled = !pickable.length;
    card.querySelector('.group-head .remove-btn').disabled = g.items.some(isActive);
}

// Ticking an item while downloading adds it to the running queue; unticking
// a queued one takes it back out.
function setChecked(it, on) {
    it.checked = on;
    if (state.downloading) {
        if (on && canQueue(it)) Object.assign(it, { status: 'queued', label: 'Queued' });
        if (!on && it.status === 'queued') Object.assign(it, { status: 'waiting', label: 'Waiting' });
    }
    paintItem(it);
}

function removeItem(it) {
    if (isActive(it)) return;
    const g = groupOf(it);
    if (!g) return;
    g.items = g.items.filter((x) => x !== it);
    if (!g.items.length) state.groups = state.groups.filter((x) => x !== g);
    saveQueue();
    renderQueue();
}

function removeGroup(g) {
    if (g.items.some(isActive)) return;
    state.groups = state.groups.filter((x) => x !== g);
    saveQueue();
    renderQueue();
}

$('clearDoneBtn').onclick = () => {
    for (const g of state.groups) g.items = g.items.filter((it) => it.status !== 'done');
    state.groups = state.groups.filter((g) => g.items.length);
    saveQueue();
    renderQueue();
};

$('clearAllBtn').onclick = () => {
    if (state.downloading) return;
    if (allItems().length > 3 && !confirm(`Remove all ${allItems().length} videos from the queue?`)) return;
    state.groups = [];
    $('overall').classList.add('hidden');
    saveQueue();
    renderQueue();
};

function updateSelection() {
    const items = allItems();
    const pending = items.filter(canQueue).length;
    const done = items.filter((it) => it.status === 'done').length;
    const total = items.reduce((s, it) => s + (it.duration || 0), 0);
    $('queueMeta').textContent = [
        `${items.length} ${items.length === 1 ? 'video' : 'videos'}`,
        done ? `${done} downloaded` : '',
        fmtTotal(total),
    ].filter(Boolean).join('  ·  ');
    $('downloadBtn').textContent = pending ? `Download ${pending}` : 'Nothing to download';
    $('downloadBtn').disabled = !pending || state.downloading;
    $('clearDoneBtn').disabled = !done;
    $('clearAllBtn').disabled = state.downloading || !items.length;
    for (const g of state.groups) paintGroupHead(g);
}

// --------------------------------------------------------------- download
function setDownloading(on) {
    state.downloading = on;
    $('cancelBtn').classList.toggle('hidden', !on);
    $('downloadBtn').classList.toggle('hidden', on);
    document.querySelectorAll('.seg, #browserSelect, #folderBtn, #subfolderChk, #numberChk, .subs-row')
        .forEach((x) => { x.style.pointerEvents = on ? 'none' : ''; x.style.opacity = on ? '0.55' : ''; });
    if (!on) paintMode();
    updateSelection();
}

function paintOverall() {
    const r = state.run;
    if (!r || r.finished) return;
    const cur = allItems().find(isActive);
    const left = allItems().filter((it) => it.status === 'queued').length + (cur ? 1 : 0);
    const count = r.done + left;
    const partial = cur && cur.status === 'downloading' ? (cur.percent || 0) / 100 : (cur && cur.status === 'processing' ? 0.99 : 0);
    $('overallFill').style.width = `${count ? Math.min(100, ((r.done + partial) / count) * 100) : 100}%`;
    $('overallText').textContent = `Downloading ${Math.min(r.done + 1, count)} of ${count}…`;
}

function downloadOptions() {
    const s = state.settings;
    return {
        mode: s.mode, quality: s.quality, browser: s.browser, outDir: s.outDir,
        subfolder: s.subfolder, number: s.number,
        subs: s.subs, subLangs: s.subLangs, autoSubs: s.autoSubs,
    };
}

$('downloadBtn').onclick = async () => {
    if (state.downloading) return;
    const todo = allItems().filter(canQueue);
    if (!todo.length) return;
    for (const it of todo) {
        Object.assign(it, { status: 'queued', label: 'Queued', percent: 0, error: null });
        paintItem(it);
    }
    state.run = { done: 0, ok: 0, failed: 0, skipped: 0, finished: false, outDir: null };
    state.stopRequested = false;
    $('overall').classList.remove('hidden');
    $('overallOpen').classList.add('hidden');
    setDownloading(true);
    paintOverall();

    const options = downloadOptions();
    // Work through the queue in order; links added meanwhile are picked up too.
    for (;;) {
        if (state.stopRequested) break;
        const it = allItems().find((x) => x.status === 'queued');
        if (!it) break;
        const g = groupOf(it);
        const result = await window.api.downloadItem({
            key: it.key, index: it.index, url: it.url, mediaUrl: it.mediaUrl, referer: it.referer, title: it.title,
            group: { isPlaylist: g.isPlaylist, title: g.title, total: g.total },
        }, options);
        if (result === 'cancelled') break;
        state.run[result === 'ok' ? 'ok' : result === 'skipped' ? 'skipped' : 'failed']++;
        state.run.done++;
        saveQueue();
    }

    const r = state.run;
    r.finished = true;
    const cancelled = state.stopRequested;
    for (const it of allItems()) if (it.status === 'queued') Object.assign(it, { status: 'waiting', label: 'Waiting' });
    const parts = [`${r.ok} downloaded`];
    if (r.skipped) parts.push(`${r.skipped} already saved`);
    if (r.failed) parts.push(`${r.failed} failed`);
    $('overallText').textContent = `${cancelled ? 'Stopped' : 'Finished'} — ${parts.join(', ')}`;
    if (!cancelled) $('overallFill').style.width = '100%';
    $('overallOpen').classList.toggle('hidden', !r.outDir);
    setDownloading(false);
    for (const it of allItems()) paintItem(it);
    saveQueue();
};

$('cancelBtn').onclick = () => {
    if (!state.downloading) return;
    state.stopRequested = true;
    $('overallText').textContent = 'Stopping…';
    window.api.cancelDownload();
};

$('overallOpen').onclick = () => state.run && state.run.outDir && window.api.openFolder(state.run.outDir);

window.api.onDownloadEvent((ev) => {
    const it = findItem(ev.key);
    if (!it) return;
    if (ev.outDir && state.run && !state.run.outDir) state.run.outDir = ev.outDir;
    if (ev.type === 'progress') {
        Object.assign(it, { status: 'downloading', label: `${ev.percent.toFixed(0)}%`, percent: ev.percent, speed: ev.speed, eta: ev.eta });
    } else if (ev.type === 'item') {
        it.status = ev.status;
        it.label = ev.label;
        if (ev.error) it.error = ev.error;
        if (ev.status === 'starting') $(`item-${it.key}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    paintItem(it);
    if (ev.type === 'item') {
        const g = groupOf(it);
        if (g) paintGroupHead(g);
        if (!isActive(it)) updateSelection();
    }
    paintOverall();
});

// ------------------------------------------------------------------- boot
initOptions().then(async () => {
    await restoreQueue();
    if (state.groups.length) renderQueue();
});
initTools();
$('linkInput').focus();
