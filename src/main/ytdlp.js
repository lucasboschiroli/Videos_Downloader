// Runs yt-dlp as a background process and turns its output into events.
//
// yt-dlp is looked for in this order:
//   1. bin/yt-dlp.exe shipped with the app (resources/bin when installed)
//   2. yt-dlp on PATH
//   3. Python's yt_dlp module (python -m yt_dlp / py -m yt_dlp)
// ffmpeg is taken from bin/ when bundled, otherwise from PATH.

const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const isWin = process.platform === 'win32';
const exe = (name) => (isWin ? `${name}.exe` : name);

let resolved = null;     // { cmd, baseArgs, label }
let current = null;      // running child process
let cancelled = false;
let busy = false;

function binDir() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'bin')
        : path.join(__dirname, '..', '..', 'bin');
}

function works(cmd, args) {
    try {
        const r = spawnSync(cmd, [...args, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
        return r.status === 0 ? r.stdout.trim() : null;
    } catch {
        return null;
    }
}

function onPath(name) {
    const r = spawnSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function resolveYtdlp() {
    if (resolved) return resolved;
    const candidates = [
        { cmd: path.join(binDir(), exe('yt-dlp')), baseArgs: [], label: 'bundled yt-dlp' },
        { cmd: 'yt-dlp', baseArgs: [], label: 'yt-dlp' },
        { cmd: 'python', baseArgs: ['-m', 'yt_dlp'], label: 'Python yt-dlp' },
        { cmd: 'py', baseArgs: ['-m', 'yt_dlp'], label: 'Python yt-dlp' },
    ];
    for (const c of candidates) {
        if (path.isAbsolute(c.cmd) && !fs.existsSync(c.cmd)) continue;
        const version = works(c.cmd, c.baseArgs);
        if (version) {
            resolved = { ...c, version };
            return resolved;
        }
    }
    return null;
}

function ffmpegPath() {
    // Bundled: hand yt-dlp the folder so it finds ffprobe next to ffmpeg.
    if (fs.existsSync(path.join(binDir(), exe('ffmpeg')))) return binDir();
    return onPath('ffmpeg');
}

// YouTube changes often and old yt-dlp versions stop working, so the bundled
// copy updates itself in the background on start. Installed copies on PATH or
// in Python are left alone; those are the user's to manage.
function selfUpdate() {
    const y = resolveYtdlp();
    if (!y || y.label !== 'bundled yt-dlp') return;
    const child = spawn(y.cmd, ['-U'], { windowsHide: true, stdio: 'ignore' });
    child.on('close', () => { resolved = null; });
    child.on('error', () => {});
}

// YouTube needs a JavaScript runtime to solve its player challenges.
// Use a real one if installed, otherwise Electron itself in Node mode.
function jsRuntimeArgs() {
    for (const name of ['deno', 'node', 'bun']) {
        const bundled = path.join(binDir(), exe(name));
        if (fs.existsSync(bundled)) return ['--js-runtimes', `${name}:${bundled}`];
        if (onPath(name)) return ['--js-runtimes', name];
    }
    return ['--js-runtimes', `node:${process.execPath}`];
}

function toolStatus() {
    const y = resolveYtdlp();
    return {
        ytdlp: y ? `${y.label} ${y.version}` : null,
        ffmpeg: ffmpegPath(),
    };
}

function commonArgs(browser) {
    const args = ['--no-colors', ...jsRuntimeArgs(), '--remote-components', 'ejs:github'];
    const ff = ffmpegPath();
    if (ff) args.push('--ffmpeg-location', ff);
    if (browser && browser !== 'none') args.push('--cookies-from-browser', browser);
    return args;
}

function run(args, onLine) {
    const y = resolveYtdlp();
    if (!y) return Promise.reject(new Error('yt-dlp was not found. Install it with: pip install yt-dlp'));
    return new Promise((resolve) => {
        const child = spawn(y.cmd, [...y.baseArgs, ...args], {
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ELECTRON_RUN_AS_NODE: '1' },
        });
        current = child;
        let stdout = '';
        let stderr = '';
        const feed = (chunk, isErr) => {
            const text = chunk.toString('utf8');
            if (isErr) stderr += text; else stdout += text;
            if (onLine) text.split(/\r?\n/).forEach((l) => l.trim() && onLine(l.trim()));
        };
        child.stdout.on('data', (c) => feed(c, false));
        child.stderr.on('data', (c) => feed(c, true));
        child.on('close', (code) => {
            current = null;
            resolve({ code, stdout, stderr });
        });
        child.on('error', (err) => {
            current = null;
            resolve({ code: -1, stdout, stderr: String(err) });
        });
    });
}

// yt-dlp's errors for the common cases, rewritten as advice.
function friendlyError(msg) {
    if (/Sign in to confirm you.re not a bot/i.test(msg)) {
        return "YouTube wants to check you're not a bot. Pick your browser under \"Cookies from\" (where you're signed in to YouTube) and try again.";
    }
    if (/Sign in to confirm your age|age-restricted/i.test(msg)) {
        return 'This video is age-restricted. Pick your browser under "Cookies from" (signed in to YouTube) and try again.';
    }
    if (/Private video|members-only|Join this channel/i.test(msg)) return 'This video is private or for channel members only.';
    if (/Video unavailable|This video has been removed/i.test(msg)) return 'This video is unavailable or was removed.';
    if (/Unsupported URL/i.test(msg)) return "This link isn't a supported video or playlist.";
    if (/Could not copy .* cookie database|Failed to decrypt with DPAPI/i.test(msg)) {
        return "Couldn't read the browser's cookies. Close that browser completely and try again, or pick another one.";
    }
    if (/Unable to download webpage|getaddrinfo|timed out|Connection reset/i.test(msg)) return 'Network problem: check your internet connection and try again.';
    return msg;
}

function lastError(stderr) {
    const lines = stderr.split(/\r?\n/).filter((l) => l.startsWith('ERROR:'));
    const msg = (lines.pop() || stderr.trim().split(/\r?\n/).pop() || 'Unknown error').replace(/^ERROR:\s*/, '');
    return friendlyError(msg.replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, ''));
}

const thumbFor = (e) =>
    (e.thumbnails && e.thumbnails.length && e.thumbnails[e.thumbnails.length - 1].url) ||
    e.thumbnail ||
    (e.id ? `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg` : null);

const gdc = require('./gdc');

async function loadPlaylist(url, { browser }) {
    if (gdc.isGdc(url)) return gdc.resolve(url);
    const { code, stdout, stderr } = await run(['-J', '--flat-playlist', '--no-warnings', ...commonArgs(browser), url]);
    if (code !== 0) throw new Error(lastError(stderr));
    const info = JSON.parse(stdout);

    if (info._type === 'playlist') {
        const items = (info.entries || []).filter(Boolean).map((e) => {
            const isYt = (e.ie_key || '').startsWith('Youtube') || /youtu/.test(e.url || '');
            return {
                id: e.id,
                url: isYt && e.id ? `https://www.youtube.com/watch?v=${e.id}` : (e.url || e.webpage_url),
                title: e.title || e.id || '(untitled)',
                duration: e.duration || null,
                channel: e.channel || e.uploader || '',
                thumbnail: thumbFor(e),
                unavailable: /^\[(Private|Deleted) video\]$/.test(e.title || ''),
            };
        });
        return {
            isPlaylist: true,
            title: info.title || 'Playlist',
            channel: info.channel || info.uploader || '',
            items,
        };
    }
    return {
        isPlaylist: false,
        title: info.title || 'Video',
        channel: info.channel || info.uploader || '',
        items: [{
            id: info.id,
            url: info.webpage_url || url,
            title: info.title || '(untitled)',
            duration: info.duration || null,
            channel: info.channel || info.uploader || '',
            thumbnail: thumbFor(info),
        }],
    };
}

function safeName(text) {
    return (text || 'Playlist').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[ .]+$/, '').trim() || 'Playlist';
}

function formatArgs(mode, quality) {
    if (mode === 'audio') {
        return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '192K',
                '--embed-metadata', '--embed-thumbnail'];
    }
    // Prefer MP4/M4A streams so the result plays everywhere without re-encoding.
    const sort = quality === 'best' ? 'ext:mp4:m4a' : `res:${quality},ext:mp4:m4a`;
    return ['-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', 'mp4', '--embed-metadata'];
}

// "en, pt" -> each language plus its common regional variants (pt-BR, en-US…),
// but not YouTube's machine translations of auto captions (pt-en, en-de…),
// which would add dozens of tracks. yt-dlp matches case-insensitively, so
// regions are listed explicitly rather than matched as "two capitals".
// Never the live chat replay either.
const REGIONS = 'BR|PT|US|GB|419|MX|CA|AU|IN|IE|NZ|ZA|Hans|Hant|TW|HK|CN';
function subLangPattern(langs) {
    const list = String(langs || '').split(/[\s,;]+/).map((l) => l.replace(/[^\w-]/g, '')).filter(Boolean);
    if (!list.length || list.some((l) => l.toLowerCase() === 'all')) return 'all,-live_chat';
    return [...list.map((l) => (l.includes('-') ? l : `${l}(-(${REGIONS}))?`)), '-live_chat'].join(',');
}

// Subtitles go inside the MP4 as tracks you can switch on in the player.
// Only --embed-subs (no --write-subs), so yt-dlp removes the loose subtitle
// files once they're embedded.
function subtitleArgs(options) {
    if (options.mode === 'audio' || !options.subs) return [];
    const args = ['--embed-subs', '--sub-langs', subLangPattern(options.subLangs)];
    if (options.autoSubs) args.push('--write-auto-subs');
    return args;
}

const STAGES = [
    [/^\[info\] Writing video subtitles/, 'Getting subtitles'],
    [/^\[SubtitlesConvertor\]/, 'Converting subtitles'],
    [/^\[EmbedSubtitle\]/, 'Adding subtitles'],
    [/^\[Merger\]/, 'Merging'],
    [/^\[ExtractAudio\]/, 'Converting to MP3'],
    [/^\[(EmbedThumbnail|ThumbnailsConvertor)\]/, 'Adding cover'],
    [/^\[Metadata\]/, 'Adding info'],
];

// Where one queued item is saved: playlists go in their own (numbered) folder.
function targetFor(item, options) {
    const g = item.group || {};
    let outDir = options.outDir;
    if (options.subfolder && g.isPlaylist) outDir = path.join(outDir, safeName(g.title));
    const width = Math.max(2, String(g.total || 1).length);
    const prefix = options.number && g.isPlaylist ? `${String(item.index).padStart(width, '0')} - ` : '';
    // Direct streams (GDC Vault) have no useful title of their own, so name them ourselves.
    const name = item.mediaUrl ? safeName(item.title).replace(/%/g, '%%') + '.%(ext)s' : '%(title)s.%(ext)s';
    return { outDir, template: path.join(outDir.replace(/%/g, '%%'), `${prefix.replace(/%/g, '%%')}${name}`) };
}

// Downloads one queued item. Resolves to 'ok' | 'skipped' | 'failed' | 'cancelled'.
async function downloadItem(item, options, emit) {
    busy = true;
    cancelled = false;
    const { outDir, template } = targetFor(item, options);
    fs.mkdirSync(outDir, { recursive: true });
    let already = false;
    let noSubs = false;

    emit({ type: 'item', key: item.key, status: 'starting', label: 'Starting', outDir });

    const wantSubs = !item.mediaUrl && subtitleArgs(options).length > 0;
    const buildArgs = (withSubs) => [
        '--newline', '--no-playlist', '--windows-filenames', '--no-overwrites', '--continue',
        '--progress-template', 'download:VDP|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
        '-o', template,
        ...formatArgs(options.mode, options.quality),
        ...(withSubs ? subtitleArgs(options) : []),
        ...commonArgs(options.browser),
        ...(item.referer ? ['--referer', item.referer] : []),
        item.mediaUrl || item.url,
    ];
    let args = buildArgs(wantSubs);

    const onLine = (line) => {
        if (line.startsWith('VDP|')) {
            const [, pct, speed, eta] = line.split('|');
            const percent = parseFloat(pct) || 0;
            emit({ type: 'progress', key: item.key, percent, speed: (speed || '').trim(), eta: (eta || '').trim() });
            return;
        }
        if (/has already been downloaded/.test(line)) already = true;
        if (/There are no subtitles for the requested languages/.test(line)) noSubs = true;
        for (const [re, label] of STAGES) {
            if (re.test(line)) emit({ type: 'item', key: item.key, status: 'processing', label });
        }
    };

    // YouTube sometimes answers 403 Forbidden for a stream that works on
    // the next try, so retry those a couple of times before giving up.
    let code, stderr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        ({ code, stderr } = await run(args, onLine));
        if (code === 0 || cancelled || attempt === 3) break;
        // A subtitle that can't be fetched (YouTube rate-limits them with
        // 429s) shouldn't cost you the video: get the video without them.
        if (wantSubs && /subtitle/i.test(lastError(stderr))) {
            args = buildArgs(false);
            noSubs = true;
            emit({ type: 'item', key: item.key, status: 'starting', label: 'Retrying without subtitles' });
            continue;
        }
        if (!/HTTP Error 403/.test(stderr)) break;
        emit({ type: 'item', key: item.key, status: 'starting', label: `Retrying (${attempt + 1}/3)` });
    }

    busy = false;
    if (cancelled) {
        emit({ type: 'item', key: item.key, status: 'cancelled', label: 'Cancelled' });
        return 'cancelled';
    }
    if (code === 0) {
        let label = already ? 'Already saved' : 'Done';
        if (wantSubs && noSubs && !already) label = 'Done · no subtitles';
        emit({ type: 'item', key: item.key, status: 'done', label, outDir });
        return already ? 'skipped' : 'ok';
    }
    // Don't leave an empty playlist folder behind when nothing could be saved.
    if (outDir !== options.outDir) {
        try { fs.rmdirSync(outDir); } catch { /* not empty: other videos are in it */ }
    }
    emit({ type: 'item', key: item.key, status: 'error', label: 'Failed', error: lastError(stderr) });
    return 'failed';
}

function cancel() {
    cancelled = true;
    if (current && current.pid) {
        // Kill the whole tree so ffmpeg doesn't keep running in the background.
        if (isWin) spawnSync('taskkill', ['/pid', String(current.pid), '/T', '/F'], { windowsHide: true });
        else current.kill('SIGTERM');
    }
}

module.exports = { toolStatus, loadPlaylist, downloadItem, cancel, selfUpdate, isBusy: () => busy };
