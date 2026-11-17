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
    const bundled = path.join(binDir(), exe('ffmpeg'));
    if (fs.existsSync(bundled)) return bundled;
    return onPath('ffmpeg');
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

function lastError(stderr) {
    const lines = stderr.split(/\r?\n/).filter((l) => l.startsWith('ERROR:'));
    const msg = (lines.pop() || stderr.trim().split(/\r?\n/).pop() || 'Unknown error').replace(/^ERROR:\s*/, '');
    return msg.replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '');
}

const thumbFor = (e) =>
    (e.thumbnails && e.thumbnails.length && e.thumbnails[e.thumbnails.length - 1].url) ||
    e.thumbnail ||
    (e.id ? `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg` : null);

async function loadPlaylist(url, { browser }) {
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

const STAGES = [
    [/^\[Merger\]/, 'Merging'],
    [/^\[ExtractAudio\]/, 'Converting to MP3'],
    [/^\[(EmbedThumbnail|ThumbnailsConvertor)\]/, 'Adding cover'],
    [/^\[Metadata\]/, 'Adding info'],
];

async function downloadAll(items, options, emit) {
    busy = true;
    cancelled = false;
    let outDir = options.outDir;
    if (options.subfolder && options.isPlaylist) outDir = path.join(outDir, safeName(options.playlistTitle));
    fs.mkdirSync(outDir, { recursive: true });

    const width = Math.max(2, String(options.total || items.length).length);
    let ok = 0, failed = 0, skipped = 0;
    emit({ type: 'start', count: items.length, outDir });

    for (let i = 0; i < items.length; i++) {
        if (cancelled) break;
        const item = items[i];
        const prefix = options.number && options.isPlaylist ? `${String(item.index).padStart(width, '0')} - ` : '';
        const template = path.join(outDir.replace(/%/g, '%%'), `${prefix}%(title)s.%(ext)s`);
        let already = false;

        emit({ type: 'item', key: item.key, status: 'starting', label: 'Starting', position: i + 1 });

        const args = [
            '--newline', '--no-playlist', '--windows-filenames', '--no-overwrites', '--continue',
            '--progress-template', 'download:VDP|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
            '-o', template,
            ...formatArgs(options.mode, options.quality),
            ...commonArgs(options.browser),
            item.url,
        ];

        const onLine = (line) => {
            if (line.startsWith('VDP|')) {
                const [, pct, speed, eta] = line.split('|');
                const percent = parseFloat(pct) || 0;
                emit({ type: 'progress', key: item.key, percent, speed: (speed || '').trim(), eta: (eta || '').trim() });
                return;
            }
            if (/has already been downloaded/.test(line)) already = true;
            for (const [re, label] of STAGES) {
                if (re.test(line)) emit({ type: 'item', key: item.key, status: 'processing', label });
            }
        };

        // YouTube sometimes answers 403 Forbidden for a stream that works on
        // the next try, so retry those a couple of times before giving up.
        let code, stderr;
        for (let attempt = 1; attempt <= 3; attempt++) {
            ({ code, stderr } = await run(args, onLine));
            if (code === 0 || cancelled || !/HTTP Error 403/.test(stderr) || attempt === 3) break;
            emit({ type: 'item', key: item.key, status: 'starting', label: `Retrying (${attempt + 1}/3)` });
        }

        if (cancelled) {
            emit({ type: 'item', key: item.key, status: 'cancelled', label: 'Cancelled' });
            break;
        }
        if (code === 0) {
            if (already) skipped++; else ok++;
            emit({ type: 'item', key: item.key, status: 'done', label: already ? 'Already saved' : 'Done' });
        } else {
            failed++;
            emit({ type: 'item', key: item.key, status: 'error', label: 'Failed', error: lastError(stderr) });
        }
    }

    busy = false;
    emit({ type: 'finished', ok, failed, skipped, cancelled, outDir });
}

function cancel() {
    cancelled = true;
    if (current && current.pid) {
        // Kill the whole tree so ffmpeg doesn't keep running in the background.
        if (isWin) spawnSync('taskkill', ['/pid', String(current.pid), '/T', '/F'], { windowsHide: true });
        else current.kill('SIGTERM');
    }
}

module.exports = { toolStatus, loadPlaylist, downloadAll, cancel, isBusy: () => busy };
