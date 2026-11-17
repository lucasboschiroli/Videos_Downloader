// GDC Vault talks. yt-dlp's own GDC Vault extractor no longer works with the
// site, so this reads the talk page, finds the embedded Blaze player, and
// resolves its HLS stream the same way the player does (aliases.json, then
// the fixed legacy address). yt-dlp then downloads the stream.

const PAGE_RE = /^https?:\/\/(www\.)?gdcvault\.com\/play\/\d+/i;
const PLAYER = 'https://gdcvault.blazestreaming.com/';
const ID_RE = /^[0-9a-f]{32}$/;
const LEGACY_TAIL = '/38549d9a185b445888c6fbc2e2e792e9/50413c5b8a95441e919f0a1579606e47/index.m3u8';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36';

const isGdc = (url) => PAGE_RE.test(String(url).trim());

const decode = (s) => String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

const meta = (html, prop) => {
    const m = new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`, 'i').exec(html);
    return m ? decode(m[1]) : '';
};

async function get(url, referer) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) } });
    if (!res.ok) throw new Error(`GDC Vault answered ${res.status} for ${url}`);
    return res;
}

async function streamFor(id) {
    try {
        const res = await get(`${PLAYER}aliases.json`, PLAYER);
        const doc = await res.json();
        const entry = doc && doc.aliases && doc.aliases[id];
        if (entry && /^https:\/\/cdn-a\.blazestreaming\.com\/out\/v1\/[0-9a-f]{32}\//.test(entry.playbackUrl)) return entry.playbackUrl;
    } catch { /* fall back to the legacy address, like the player does */ }
    return `https://cdn-a.blazestreaming.com/out/v1/${id}${LEGACY_TAIL}`;
}

async function resolve(url) {
    const page = url.trim();
    const html = await (await get(page)).text();

    const player = /<iframe[^>]+src="https:\/\/gdcvault\.blazestreaming\.com\/\?id=([0-9a-f]{32})"/i.exec(html);
    if (!player || !ID_RE.test(player[1])) {
        if (/members only/i.test(html)) {
            throw new Error('This GDC Vault talk is for members only, so it can\'t be downloaded without a GDC Vault subscription.');
        }
        throw new Error('No video was found on this GDC Vault page.');
    }

    const title = meta(html, 'og:title') || decode((/<title>([^<]*)<\/title>/i.exec(html) || [])[1]).replace(/^GDC Vault - /, '') || 'GDC talk';
    const speaker = decode(((/Speaker\(s\):[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/i.exec(html) || [])[1] || '').replace(/<[^>]+>/g, ' '));
    const mediaUrl = await streamFor(player[1]);

    return {
        isPlaylist: false,
        title,
        channel: speaker ? `GDC Vault · ${speaker}` : 'GDC Vault',
        items: [{
            id: player[1],
            url: page,
            mediaUrl,
            referer: PLAYER,
            title,
            duration: null,
            channel: speaker ? `GDC Vault · ${speaker}` : 'GDC Vault',
            thumbnail: meta(html, 'og:image') || null,
        }],
    };
}

module.exports = { isGdc, resolve };
