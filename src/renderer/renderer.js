const $ = (id) => document.getElementById(id);

const state = {
    settings: null,
    playlist: null,     // { title, channel, isPlaylist, items: [...] }
    downloading: false,
    run: null,          // { count, done, current, outDir }
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
    for (const id of ['emptyState', 'loadingState', 'errorState', 'playlist']) {
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

// ------------------------------------------------------------------- load
$('pasteBtn').onclick = async () => {
    try {
        $('linkInput').value = (await navigator.clipboard.readText()).trim();
        $('linkInput').focus();
    } catch { /* clipboard blocked */ }
};

$('linkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('linkInput').value.trim();
    if (!url || state.downloading) return;
    $('loadBtn').disabled = true;
    show('loadingState');
    try {
        const pl = await window.api.loadPlaylist(url, state.settings.browser);
        pl.items = pl.items.map((it, i) => ({
            ...it, key: String(i), index: i + 1, checked: !it.unavailable,
            status: it.unavailable ? 'unavailable' : 'waiting', label: it.unavailable ? 'Unavailable' : 'Waiting',
        }));
        state.playlist = pl;
        renderPlaylist();
        show('playlist');
    } catch (err) {
        $('errorText').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        show('errorState');
    } finally {
        $('loadBtn').disabled = false;
    }
});

// --------------------------------------------------------------- playlist
function renderPlaylist() {
    const pl = state.playlist;
    $('plTitle').textContent = pl.title;
    const total = pl.items.reduce((s, it) => s + (it.duration || 0), 0);
    const bits = [pl.channel, `${pl.items.length} ${pl.items.length === 1 ? 'video' : 'videos'}`, fmtTotal(total)].filter(Boolean);
    $('plMeta').textContent = bits.join('  ·  ');
    $('overall').classList.add('hidden');

    const list = $('items');
    list.innerHTML = '';
    for (const it of pl.items) list.appendChild(renderItem(it));
    updateSelection();
}

function renderItem(it) {
    const li = el('li', 'item');
    li.id = `item-${it.key}`;

    const check = el('label', 'item-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = it.checked;
    box.disabled = !!it.unavailable;
    box.onchange = () => { it.checked = box.checked; updateSelection(); };
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
    title.title = 'Open on YouTube';
    title.onclick = () => window.api.openLink(it.url);
    const sub = el('div', 'item-sub', it.channel || '');
    const bar = el('div', 'bar hidden');
    bar.appendChild(el('div', 'bar-fill'));
    body.append(title, sub, bar);

    const status = el('span', `status ${statusClass(it.status)}`, it.label);

    li.append(check, idx, thumb, body, status);
    paintItem(it, li);
    return li;
}

function statusClass(s) {
    return { starting: 'active', downloading: 'active', processing: 'active', done: 'done', error: 'error', cancelled: 'cancelled' }[s] || '';
}

function paintItem(it, li = $(`item-${it.key}`)) {
    if (!li) return;
    li.classList.toggle('unchecked', !it.checked);
    li.classList.toggle('active', ['starting', 'downloading', 'processing'].includes(it.status));
    const status = li.querySelector('.status');
    status.className = `status ${statusClass(it.status)}`;
    status.textContent = it.label;

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
    const showBar = ['downloading', 'processing'].includes(it.status);
    bar.classList.toggle('hidden', !showBar);
    bar.firstChild.style.width = `${it.status === 'processing' ? 100 : (it.percent || 0)}%`;
}

function selectedItems() {
    return state.playlist ? state.playlist.items.filter((it) => it.checked && !it.unavailable) : [];
}

function updateSelection() {
    const sel = selectedItems().length;
    const avail = state.playlist.items.filter((it) => !it.unavailable).length;
    $('selectAll').checked = sel === avail && avail > 0;
    $('downloadBtn').textContent = sel === avail ? `Download all (${sel})` : `Download ${sel} selected`;
    $('downloadBtn').disabled = sel === 0 || state.downloading;
}

$('selectAll').onchange = (e) => {
    if (!state.playlist || state.downloading) return;
    for (const it of state.playlist.items) {
        if (it.unavailable) continue;
        it.checked = e.target.checked;
        const box = $(`item-${it.key}`).querySelector('input');
        box.checked = it.checked;
        paintItem(it);
    }
    updateSelection();
};

// --------------------------------------------------------------- download
function setDownloading(on) {
    state.downloading = on;
    $('cancelBtn').classList.toggle('hidden', !on);
    $('downloadBtn').classList.toggle('hidden', on);
    $('loadBtn').disabled = on;
    $('selectAll').disabled = on;
    document.querySelectorAll('.item-check input').forEach((b) => { b.disabled = on || b.closest('.item') && !!findItem(b.closest('.item').id.slice(5))?.unavailable; });
    document.querySelectorAll('.seg, #browserSelect, #folderBtn, #subfolderChk, #numberChk, .subs-row')
        .forEach((x) => { x.style.pointerEvents = on ? 'none' : ''; x.style.opacity = on ? '0.55' : ''; });
    if (!on) { paintMode(); updateSelection(); }
}

function findItem(key) {
    return state.playlist && state.playlist.items.find((it) => it.key === key);
}

function paintOverall() {
    const r = state.run;
    if (!r) return;
    const cur = r.current ? findItem(r.current) : null;
    const partial = cur && cur.status === 'downloading' ? (cur.percent || 0) / 100 : (cur && cur.status === 'processing' ? 0.99 : 0);
    const pct = Math.min(100, ((r.done + partial) / r.count) * 100);
    $('overallFill').style.width = `${pct}%`;
    if (!r.finished) $('overallText').textContent = `Downloading ${Math.min(r.done + 1, r.count)} of ${r.count}…`;
}

$('downloadBtn').onclick = async () => {
    const items = selectedItems();
    if (!items.length || state.downloading) return;
    for (const it of items) {
        Object.assign(it, { status: 'waiting', label: 'Waiting', percent: 0, error: null });
        paintItem(it);
    }
    state.run = { count: items.length, done: 0, current: null, finished: false };
    $('overall').classList.remove('hidden');
    $('overallOpen').classList.add('hidden');
    setDownloading(true);
    paintOverall();

    const s = state.settings;
    await window.api.startDownload(
        items.map((it) => ({ key: it.key, index: it.index, url: it.url })),
        {
            mode: s.mode, quality: s.quality, browser: s.browser, outDir: s.outDir,
            subfolder: s.subfolder, number: s.number,
            subs: s.subs, subLangs: s.subLangs, autoSubs: s.autoSubs,
            isPlaylist: state.playlist.isPlaylist, playlistTitle: state.playlist.title,
            total: state.playlist.items.length,
        },
    );
};

$('cancelBtn').onclick = () => {
    if (!state.downloading) return;
    $('overallText').textContent = 'Cancelling…';
    window.api.cancelDownload();
};

$('overallOpen').onclick = () => state.run && window.api.openFolder(state.run.outDir);

window.api.onDownloadEvent((ev) => {
    const r = state.run;
    if (!r) return;
    if (ev.type === 'start') {
        r.outDir = ev.outDir;
        return;
    }
    if (ev.type === 'finished') {
        r.finished = true;
        const parts = [`${ev.ok} downloaded`];
        if (ev.skipped) parts.push(`${ev.skipped} already saved`);
        if (ev.failed) parts.push(`${ev.failed} failed`);
        $('overallText').textContent = `${ev.cancelled ? 'Cancelled' : 'Finished'} — ${parts.join(', ')}`;
        if (!ev.cancelled) $('overallFill').style.width = '100%';
        $('overallOpen').classList.remove('hidden');
        setDownloading(false);
        return;
    }

    const it = findItem(ev.key);
    if (!it) return;
    if (ev.type === 'progress') {
        Object.assign(it, { status: 'downloading', label: `${ev.percent.toFixed(0)}%`, percent: ev.percent, speed: ev.speed, eta: ev.eta });
    } else if (ev.type === 'item') {
        it.status = ev.status;
        it.label = ev.label;
        if (ev.error) it.error = ev.error;
        if (ev.status === 'starting') {
            r.current = it.key;
            $(`item-${it.key}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        if (['done', 'error'].includes(ev.status)) r.done++;
    }
    paintItem(it);
    paintOverall();
});

// ------------------------------------------------------------------- boot
initOptions();
initTools();
$('linkInput').focus();
