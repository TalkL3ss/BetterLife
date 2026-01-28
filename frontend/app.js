// =============================================
// API KEYS (Pre-configured)
// =============================================
const API_KEYS = {
    newsdata: 'pub_13a914590d954af5a5e59aaef487cece',
    openweather: '2e1d472bc1b48449837208507a2367af',
    aviationstack: 'd2d07ed1b949906c12da683a816baa1b',
    aerodatabox: '3c52c3801dmshb70129bb162afaep1c0e03jsn4315c008bb36',
    // npoint.io for shared caching (all users see same data) - free, no rate limits
    npoint: 'fed9ee910656da13bf03',
    // Telegram bot for alerts
    telegram: '8407070441:AAEk7XWXyL5rMOVmGIkp_461bUJSw_6QaSc',
};

const TELEGRAM_CHANNEL = '@BetterLifeAlerts';

// JSONbin configuration
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

const URL_PARAMS = new URLSearchParams(window.location.search);
// Safety: never let random clients overwrite the shared cache unless explicitly enabled.
const ALLOW_SHARED_CACHE_WRITE = URL_PARAMS.has('write');
const ALLOW_TELEGRAM_ALERTS = URL_PARAMS.has('alerts');

// Analytics helper (safe no-op if GA/gtag isn't available)
function trackEvent(action, category = 'engagement', label = null, value = null, extra = null) {
    try {
        if (typeof gtag !== 'function') return;
        const params = { event_category: category };
        if (label !== null && label !== undefined) params.event_label = label;
        if (value !== null && value !== undefined) params.value = value;
        if (extra && typeof extra === 'object') Object.assign(params, extra);
        gtag('event', action, params);
    } catch (e) { }
}

function safeGtagEvent(name, params) {
    try {
        if (typeof gtag !== 'function') return;
        gtag('event', name, params || {});
    } catch (e) { }
}

const state = {
    risk: 0,
    feedItems: [],
    seenHeadlines: new Set(),
    trendData: [],
    trendLabels: [],
    sourceLists: {},
    cacheSeedMs: null,
    lastCacheSeenMs: 0,
    usingLocalCache: false,
    // Cache last known values for when APIs fail
    lastKnown: {
        aviation: { value: 5, detail: 'Cached data' }
    },
    // Signal history for sparklines (20 data points each)
    signalHistory: {
        news: [],
        social: [],
        flight: [],
        maritime: [],
        tanker: [],
        military: [],
        markets: [],
        pentagon: [],
        polymarket: [],
        airspace: [],
        weather: [],
        gps: [],
        diplomats: []
    },
    lastSignalSnapshot: null,
    lastDeescalationAt: 0
};

// Generate sparkline SVG with smooth curves
function generateSparkline(data, color = '#22c55e') {
    if (!data || data.length < 2) return '';

    const width = 60;
    const height = 24;
    const padding = 2;

    // Normalize data to fit in the SVG
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    // Generate path points
    const points = data.map((val, i) => {
        const x = padding + (i / (data.length - 1)) * (width - padding * 2);
        const y = height - padding - ((val - min) / range) * (height - padding * 2);
        return { x, y };
    });

    // Create smooth curve using cubic bezier
    let linePath = `M ${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const cpx = (prev.x + curr.x) / 2;
        linePath += ` C ${cpx},${prev.y} ${cpx},${curr.y} ${curr.x},${curr.y}`;
    }

    // Create area path (for gradient fill)
    const areaPath = linePath + ` L ${points[points.length - 1].x},${height - padding} L ${points[0].x},${height - padding} Z`;

    return `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
            <defs>
                <linearGradient id="sparkGrad_${color.replace('#', '')}" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
                    <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <path class="sparkline-area" d="${areaPath}" fill="url(#sparkGrad_${color.replace('#', '')})"/>
            <path class="sparkline-line" d="${linePath}" stroke="${color}"/>
        </svg>
    `;
}

// Update sparkline for a signal
function updateSparkline(name, value, color) {
    const container = document.getElementById(`${name}Sparkline`);
    if (!container) return;

    // Get history or generate mimicked data
    let history = state.signalHistory[name] || [];

    // Add current value if different from last
    if (history.length === 0 || history[history.length - 1] !== value) {
        history.push(value);
    }

    // Keep only last 20 points
    if (history.length > 20) {
        history = history.slice(-20);
    }

    state.signalHistory[name] = history;

    // If we don't have enough data yet, generate mimicked historical data
    if (history.length < 5) {
        const mimickedData = generateMimickedHistory(value, 20, name);
        container.innerHTML = generateSparkline(mimickedData, color);
    } else {
        container.innerHTML = generateSparkline(history, color);
    }
}

// Generate mimicked historical data based on current value
function generateMimickedHistory(currentValue, points, signalName) {
    const data = [];
    const seed = Math.floor(Date.now() / (24 * 60 * 60 * 1000)); // Stable per day
    const signalSeed = signalName.charCodeAt(0) * 17 + signalName.length * 31;

    // Use fewer points for smoother look
    const actualPoints = 12;

    // Create gentle curve unique to each signal
    for (let i = 0; i < actualPoints; i++) {
        // Very gentle wave with long period
        const t = i / actualPoints;
        const wave = Math.sin(t * Math.PI * 0.8 + signalSeed * 0.1) * 3;

        // Slight trend based on signal
        const trend = (signalSeed % 3 - 1) * t * 2;

        const value = Math.max(5, Math.min(95, currentValue + wave + trend));
        data.push(Math.round(value));
    }

    // Ensure last point is current
    data[data.length - 1] = currentValue;

    return data;
}

// Get color based on value
function getSparklineColor(value) {
    if (value >= 70) return '#ef4444'; // red
    if (value >= 50) return '#f97316'; // orange
    if (value >= 30) return '#eab308'; // yellow
    return '#22c55e'; // green
}

const KEYWORDS = ['retaliation', 'strike', 'attack', 'escalation', 'military', 'threat', 'imminent', 'missile', 'nuclear', 'war'];

const OSINT_SIGNALS = {
    gps: {
        maxContribution: 8, // % points added to total risk
        baseline: 0.5
    },
    diplomats: {
        maxContribution: 12, // higher weight: evacuations/withdrawals can precede escalation
        baseline: 0.5
    },
    maritime: {
        maxContribution: 12, // Strait of Hormuz maritime Notices to Mariners / navigation warnings
        baseline: 0.5
    }
};

function analyzeOsintFromArticles(articles) {
    const out = {
        hasData: Array.isArray(articles) && articles.length > 0,
        gps: { count: 0, critical: 0, contribution: OSINT_SIGNALS.gps.baseline, detail: 'No spoofing/jamming reports detected' },
        diplomats: { count: 0, critical: 0, contribution: OSINT_SIGNALS.diplomats.baseline, detail: 'No diplomatic movement signals detected' },
        maritime: { count: 0, critical: 0, contribution: OSINT_SIGNALS.maritime.baseline, detail: 'No Hormuz maritime advisories detected', samples: [] }
    };
    if (!out.hasData) return out;

    const warContextRe = /(strike|attack|airstrike|bomb|missile|drone|war|retaliat|escalat|imminent|hostilit)/i;
    const gpsRe = /(gps|gnss)/i;
    const interferenceRe = /(spoof|jamm|interference|spoofing|jamming)/i;
    const ewRe = /(electronic warfare|\bew\b|jamming campaign|signal interference)/i;

    const dipAnchorRe = /(diplomat|diplomatic|embassy|consulate|ambassador|charg[ée] d'affaires|mission staff)/i;
    const dipMoveRe = /(evacuat|ordered departure|withdraw|relocat|transfer|reassign|sent home|recalled|closed|shut(ting)?|downsizing)/i;
    const dipCriticalRe = /(ordered departure|evacuat|withdraw|closed embassy|embassy closure)/i;

    // Maritime NtM / navigation warnings (Strait of Hormuz + nearby chokepoints)
    const hormuzRe = /(strait of hormuz|\bhormuz\b|gulf of oman|persian gulf|khawr|khawr fakkan|qeshm|bandar abbas|musandam)/i;
    const ntmRe = /(notice(s)? to mariners|\bntm\b|navarea|navtex|navigational warning|nav warning|maritime safety information|\bmsi\b|maritime (security )?advisory|shipping advisory|ukmto|msc-hoa|imac)/i;
    const maritimeCriticalRe = /(avoid|do not transit|do not proceed|suspend|closure|closed|interference|mines?|mine threat|missile|drone|uav|attack|seiz|board(ing)?|hijack|explosion|harass|intercept|armed|warship|irgc|\bnavy\b|tanker)/i;

    for (const a of articles) {
        const text = `${a?.title || ''} ${a?.description || ''} ${a?.content || ''}`.trim();
        if (!text) continue;

        // GPS/GNSS spoofing/jamming indicator (article-level, not raw mention counts)
        const gpsHit = gpsRe.test(text) && interferenceRe.test(text);
        if (gpsHit) {
            out.gps.count += 1;
            if (ewRe.test(text) || warContextRe.test(text)) out.gps.critical += 1;
        }

        // Diplomatic movement indicator: diplomats/embassy + movement/evacuation language
        const dipHit = dipAnchorRe.test(text) && dipMoveRe.test(text);
        if (dipHit) {
            out.diplomats.count += 1;
            if (dipCriticalRe.test(text) || warContextRe.test(text)) out.diplomats.critical += 1;
        }

        const maritimeHit = hormuzRe.test(text) && ntmRe.test(text);
        if (maritimeHit) {
            out.maritime.count += 1;
            if (maritimeCriticalRe.test(text) || warContextRe.test(text)) out.maritime.critical += 1;
            if (out.maritime.samples.length < 3) {
                const t = (a?.title || '').trim();
                if (t) out.maritime.samples.push(t);
            }
        }
    }

    const gps = out.gps;
    const diplomats = out.diplomats;
    const maritime = out.maritime;

    gps.contribution = Math.min(OSINT_SIGNALS.gps.maxContribution, OSINT_SIGNALS.gps.baseline + gps.count * 2 + gps.critical * 1);
    diplomats.contribution = Math.min(OSINT_SIGNALS.diplomats.maxContribution, OSINT_SIGNALS.diplomats.baseline + diplomats.count * 3 + diplomats.critical * 2);
    maritime.contribution = Math.min(OSINT_SIGNALS.maritime.maxContribution, OSINT_SIGNALS.maritime.baseline + maritime.count * 3 + maritime.critical * 2);

    gps.detail = gps.count === 0 ? 'No spoofing/jamming reports detected' : `${gps.count} reports, ${gps.critical} high-signal`;
    diplomats.detail = diplomats.count === 0 ? 'No diplomatic movement signals detected' : `${diplomats.count} items, ${diplomats.critical} high-signal`;
    maritime.detail = maritime.count === 0 ? 'No Hormuz maritime advisories detected' : `${maritime.count} items, ${maritime.critical} high-signal`;

    return out;
}

const INFO_CONTENT = {
    news: {
        title: 'News Intelligence',
        body: '<strong>Source:</strong> RSS Feeds (BBC, Al Jazeera) - Updated every 30 min<br><br><strong>What it tracks:</strong> News articles mentioning Iran, military strike, Pentagon, CENTCOM.<br><br><strong>Risk logic:</strong> Baseline ~3-5 articles = low risk. 10+ articles with alert keywords (strike, attack, imminent) = high risk.<br><br><strong>Max contribution:</strong> 30%<br><br><em>Data is cached server-side for consistency.</em>'
    },
    trends: {
        title: 'Public Interest',
        body: '<strong>Sources:</strong> GDELT + Wikipedia<br><br><strong>GDELT:</strong> Global Database of Events monitors news from 65 languages, tracking Iran-related articles and their tone (positive/negative sentiment).<br><br><strong>Wikipedia:</strong> Pageviews on "Iran", "Iran-US relations", and "Iran-Israel conflict" pages.<br><br><strong>Risk logic:</strong> High GDELT article count + negative tone = elevated. Wikipedia spikes above 80k/day = public concern. Combined signals give early warning.<br><br><strong>Max contribution:</strong> 20%'
    },
    aviation: {
        title: 'Civil Aviation',
        body: '<strong>Source:</strong> OpenSky Network (ADS-B)<br><br><strong>What it tracks:</strong> Real-time commercial aircraft flying over Iran airspace.<br><br><strong>Baseline:</strong> Normal traffic shows 20-50+ aircraft over Iran at any time.<br><br><strong>Risk logic:</strong> A sudden DROP in aircraft count may indicate airlines avoiding the area = potential risk indicator.<br>• 30+ aircraft = Normal (low risk)<br>• 15-30 = Slightly reduced<br>• 5-15 = Below normal (elevated)<br>• <5 = Very low (high risk)<br><br><strong>Note:</strong> This is one signal among many. Traffic changes can have many causes.<br><br><strong>Max contribution:</strong> 15%'
    },
    markets: {
        title: 'Stock Markets',
        body: '<strong>Source:</strong> S&P 500 (US), Israel ETF (IL), Bitcoin (BTC), and Ethereum (ETH)<br><br><strong>What it tracks:</strong> Rapid risk-off moves that may correlate with escalation fears.<br><br><strong>Special note (BTC/ETH):</strong> Crypto trades <strong>24/7</strong>, so BTC/ETH moves have extra weight when estimating short-term sentiment.<br><br><strong>Risk logic:</strong><br>• Markets mostly green = lower risk contribution<br>• Sharp BTC/ETH selloff (live) adds extra risk weight<br><br><strong>Max contribution:</strong> 15%'
    },
    airspace: {
        title: 'Airspace NOTAMs',
        body: '<strong>Source:</strong> FAA / Eurocontrol NOTAMs<br><br><strong>What it tracks:</strong> Official "Notice to Airmen" warnings for Tehran (OIIX) and Tel Aviv (LLLL) Flight Information Regions.<br><br><strong>Risk logic:</strong><br>• Normal/Caution = Low Risk<br>• Restricted/Prohibited = High Risk<br><br><strong>Max contribution:</strong> 15%'
    },
    military: {
        title: 'Military Trackers',
        body: '<strong>Source:</strong> OpenSky ADS-B (heuristic)<br><br><strong>What it tracks:</strong> A coarse count of tracked military-coded aircraft (and some tanker-like callsigns) over a broad regional box (Levant/Iraq/Gulf/Iran).<br><br><strong>Risk logic:</strong> More tracked assets = higher contribution. This is a rough OSINT signal and may be incomplete.<br><br><strong>Max contribution:</strong> 15%'
    },
    polymarket: {
        title: 'Market Odds (Polymarket)',
        body: '<strong>Source:</strong> Polymarket Gamma API<br><br><strong>What it tracks:</strong> Prediction market odds for "US strikes Iran" events. Real money betting markets often predict events accurately.<br><br><strong>Risk logic:</strong> Direct % from market odds. If traders bet 30% chance of strike, signal shows 30%.<br><br><strong>Max contribution:</strong> 10%'
    },
    weather: {
        title: 'Operational Conditions (Weather)',
        body: '<strong>Source:</strong> OpenWeatherMap (Tehran)<br><br><strong>What it tracks:</strong> Basic visibility / cloud / precipitation / wind conditions that can affect operational feasibility.<br><br><strong>Risk logic:</strong> Clear/low clouds + good visibility = more favorable conditions = slightly higher risk contribution.<br><br><strong>Max contribution:</strong> 5%'
    },
    gps: {
        title: 'GPS/GNSS Interference (OSINT)',
        body: '<strong>Source:</strong> OSINT keyword extraction from the latest cached news batch (server-side)<br><br><strong>What it tracks:</strong> Reports mentioning GPS/GNSS <em>jamming</em>, <em>spoofing</em>, or navigation interference in relevant coverage.<br><br><strong>Why it matters:</strong> Widespread spoofing/jamming can accompany electronic warfare and may correlate with heightened operational activity.<br><br><strong>Risk logic:</strong> More independent reports + war-context language increases contribution.<br><br><strong>Max contribution:</strong> 8%'
    },
    diplomats: {
        title: 'Diplomatic Posture (OSINT)',
        body: '<strong>Source:</strong> OSINT keyword extraction from the latest cached news batch (server-side)<br><br><strong>What it tracks:</strong> Mentions of embassy/consulate staff movements (evacuations, ordered departures, withdrawals, relocations).<br><br><strong>Why it matters:</strong> Diplomatic drawdowns can be a leading indicator of elevated security risk.<br><br><strong>Risk logic:</strong> Movement language + strong terms (evacuation/ordered departure) increases contribution.<br><br><strong>Max contribution:</strong> 12%'
    },
    maritime: {
        title: 'Maritime NtM (Hormuz)',
        body: '<strong>Source:</strong> OSINT keyword extraction from the latest cached news batch (server-side)<br><br><strong>What it tracks:</strong> Mentions of <em>Notices to Mariners</em> / navigation warnings / shipping advisories tied to the <strong>Strait of Hormuz</strong> and nearby waters (Gulf of Oman / Persian Gulf).<br><br><strong>Why it matters:</strong> Formal maritime advisories or warnings around a chokepoint can signal heightened risk to shipping and increased operational posture.<br><br><strong>Risk logic:</strong> More independent items + stronger warning language increases contribution.<br><br><strong>Max contribution:</strong> 12%'
    },
    pentagon: {
        title: 'Pentagon Pizza Meter',
        body: '<strong>Source:</strong> Time-based simulation (GitHub Actions)<br><br><strong>What it tracks:</strong> Simulates pizza delivery activity patterns near the Pentagon based on time of day.<br><br><strong>Risk logic:</strong> If late night hours or weekends show elevated activity, it may indicate staff working overtime = potential elevated activity.<br><br><strong>Baseline:</strong> Normal = ~10%. Spikes during unusual late-night/weekend periods.<br><br><strong>Inspiration:</strong> During the 1991 Gulf War, journalists noticed pizza deliveries to the Pentagon spiked before major operations.<br><br><strong>Max contribution:</strong> 10%'
    },
    calculation: {
        title: 'How We Calculate Risk',
        body: '<strong>Projected Risk (Next 8 Hours) = Combined Signal Score + Short-Term Projection</strong><br><br><strong>Base Score:</strong> Sum of signals below.<br><br><strong>Projection:</strong> Uses the last ~6 hours trend slope + an IOC boost (strong indicators) to estimate the next 8 hours.<br><br>📰 <strong>News Intel (max 30%):</strong> Cached news volume + alert keywords.<br><br>📈 <strong>Public Interest (max 20%):</strong> GDELT + Wikipedia attention signals.<br><br>✈️ <strong>Civil Aviation (max 15%):</strong> Air traffic over Iran; fewer flights can indicate avoidance.<br><br>🚢 <strong>Maritime NtM (Hormuz) (max 12%):</strong> Shipping/navigation advisory mentions tied to the Strait of Hormuz (OSINT).<br><br>🎯 <strong>Military Trackers (max 15%):</strong> Heuristic tracked military-coded aircraft/tanker-like callsigns over the region (OSINT).<br><br>📉 <strong>Stock Markets (max 15%):</strong> Major market stress indicator.<br><br>📊 <strong>Market Odds (max 10%):</strong> Polymarket odds for related events.<br><br>🍕 <strong>Pentagon Pizza Meter (max 10%):</strong> Simulated activity pattern indicator.<br><br>🚫 <strong>Airspace NOTAMs (max 15%):</strong> Restricted/prohibited airspace warnings.<br><br>🛰️ <strong>GPS/GNSS Interference (max 8%):</strong> OSINT reports of spoofing/jamming; higher if war-context appears.<br><br>🏛️ <strong>Diplomatic Posture (max 12%):</strong> OSINT mentions of embassy staff moves (ordered departure/evacuation = strong).<br><br>🌤️ <strong>Op. Conditions (max 5%):</strong> Weather in Tehran; clearer conditions slightly increase risk contribution.<br><br><strong>IOC Highlighting:</strong> Signals with stronger attack indicators get an <strong>IOC</strong> badge and glow.<br><br><strong>Escalation Multiplier:</strong> If 3+ signals are elevated, base score gets a 15% boost.<br><br><strong>Risk Levels:</strong><br>• 0-30% = Low Risk<br>• 31-60% = Elevated<br>• 61-85% = High Risk<br>• 86-100% = Imminent'
    },
    about: {
        title: 'About BetterLife',
        body: '<strong>⚠️ Disclaimer</strong><br><br>This is an <strong>experimental project</strong> for informational purposes only.<br><br><strong>NOT:</strong><br>• Official intelligence<br>• Verified predictions<br>• Basis for decisions<br><br><strong>Data Sources</strong><br>• NewsData.io<br>• GDELT Project<br>• Wikipedia<br>• Aviationstack<br>• OpenWeatherMap<br><br><strong>Credits</strong><br>Original author/project inspiration: <a href="https://backyonatan-alt.github.io/aegis/" target="_blank" rel="noopener noreferrer">https://backyonatan-alt.github.io/aegis/</a><br><br><strong>Limitations</strong><br>Cannot account for classified intel, private channels, or most behind-the-scenes diplomatic activity. One data point among many.<br><br><em>Stay informed. Think critically.</em>'
    }
};

let chart;
let lastUpdateTime = null;
let countdownInterval = null;
let maxRiskSeen = 0;

// Utilities
function toFiniteNumber(value, fallback = 0) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function computeTrendSlope(history, windowHours = 6) {
    if (!Array.isArray(history) || history.length < 2) return 0;
    const now = Date.now();
    const cutoff = now - windowHours * 60 * 60 * 1000;
    const points = history
        .map(h => ({ t: toFiniteNumber(h?.timestamp, 0), r: toFiniteNumber(h?.risk, NaN) }))
        .filter(p => p.t >= cutoff && Number.isFinite(p.r));
    if (points.length < 2) return 0;
    points.sort((a, b) => a.t - b.t);
    const first = points[0];
    const last = points[points.length - 1];
    const hours = (last.t - first.t) / (60 * 60 * 1000);
    if (hours <= 0.25) return 0;
    return (last.r - first.r) / hours; // % points per hour
}

function projectRiskNext8Hours(nowRisk, history, iocScore = 0) {
    const slopePerHour = computeTrendSlope(history, 6);
    const slopeEffect = Math.max(-12, Math.min(12, slopePerHour * 8)); // cap
    const iocEffect = Math.min(10, Math.max(0, toFiniteNumber(iocScore, 0) * 1.25));
    const projected = toFiniteNumber(nowRisk, 0) + slopeEffect + iocEffect;
    return Math.round(Math.max(0, Math.min(100, projected)));
}

const getTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone.split('/').pop().replace('_', ' ');
const formatTime = () => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const formatDate = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function getColor(v) { return v >= 86 ? 'red' : v >= 61 ? 'orange' : v >= 31 ? 'yellow' : 'green'; }
function getGradient(v) { return v >= 86 ? 'url(#gradRed)' : v >= 61 ? 'url(#gradOrange)' : v >= 31 ? 'url(#gradYellow)' : 'url(#gradGreen)'; }
function getStatusText(v) { return v >= 86 ? 'Imminent' : v >= 61 ? 'High Risk' : v >= 31 ? 'Elevated' : 'Low Risk'; }
function getStatusClass(v) { return v >= 86 ? 'imminent' : v >= 61 ? 'high' : v >= 31 ? 'elevated' : 'low'; }

function setStatus(id, live) {
    const el = document.getElementById(id);
    el.textContent = live ? 'LIVE' : 'WEAK';
    el.className = `signal-status ${live ? 'live' : 'weak'}`;
}

function updateTimestamp(cacheTimestamp = null) {
    // Use cache timestamp if provided, otherwise current time.
    // Avoid restarting the 30m countdown if the timestamp didn't actually change.
    const next = cacheTimestamp ? new Date(cacheTimestamp) : new Date();
    if (lastUpdateTime && next && lastUpdateTime.getTime && next.getTime && lastUpdateTime.getTime() === next.getTime()) {
        return;
    }
    lastUpdateTime = next;
    // Format the time from the actual data timestamp
    const hours = lastUpdateTime.getUTCHours().toString().padStart(2, '0');
    const mins = lastUpdateTime.getUTCMinutes().toString().padStart(2, '0');
    document.getElementById('lastUpdate').textContent = `${hours}:${mins}`;
    document.getElementById('timezone').textContent = 'UTC';
    startCountdown();
}

function updatePyLastUpdate(data) {
    const el = document.getElementById('pyLastUpdate');
    if (!el) return;

    const candidates = [
        data?.strikeraedar_updated_ms,
        data?.airspace?.timestamp,
        data?.markets?.timestamp,
        data?.pentagon?.timestamp,
        data?.pentagon_updated,
        data?.strikeraedar_updated,
        data?.timestamp,
    ];

    let best = null;
    for (const ts of candidates) {
        if (!ts) continue;
        let t = null;
        if (typeof ts === 'number') t = new Date(ts);
        else if (typeof ts === 'string') {
            const ms = Date.parse(ts);
            if (Number.isFinite(ms)) t = new Date(ms);
        }
        if (!t || Number.isNaN(t.getTime())) continue;
        if (!best || t.getTime() > best.getTime()) best = t;
    }

    if (!best) {
        el.textContent = '---';
        return;
    }

    const hh = best.getUTCHours().toString().padStart(2, '0');
    const mm = best.getUTCMinutes().toString().padStart(2, '0');
    el.textContent = `${hh}:${mm} UTC`;
}

function safeExternalUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return null;
    return trimmed;
}

function getFirstArticleUrl(articles) {
    if (!Array.isArray(articles)) return null;
    for (const a of articles) {
        const u = safeExternalUrl(a?.url) || safeExternalUrl(a?.link) || safeExternalUrl(a?.source_url);
        if (u) return u;
    }
    return null;
}

function getArticleSources(articles, max = 6) {
    if (!Array.isArray(articles)) return [];
    const out = [];
    const seen = new Set();
    for (const a of articles) {
        const url = safeExternalUrl(a?.url) || safeExternalUrl(a?.link) || safeExternalUrl(a?.source_url);
        if (!url || seen.has(url)) continue;
        const title = String(a?.title || a?.headline || 'Source').trim() || 'Source';
        out.push({ title, url });
        seen.add(url);
        if (out.length >= max) break;
    }
    return out;
}

const SOURCE_URLS = {
    news: null, // dynamic (article) fallback is set in updateSourceLinks
    trends: 'https://www.gdeltproject.org/',
    aviation: 'https://opensky-network.org/',
    maritime: 'https://www.ukmto.org/',
    military: 'https://opensky-network.org/',
    markets: 'https://finance.yahoo.com/',
    pentagon: 'https://en.wikipedia.org/wiki/Pentagon_Pizza_Index',
    polymarket: 'https://polymarket.com/',
    airspace: 'https://notams.aim.faa.gov/notamSearch/',
    weather: 'https://openweathermap.org/api',
    gps: null, // dynamic (article) fallback is set in updateSourceLinks
    diplomats: null // dynamic (article) fallback is set in updateSourceLinks
};

function setSourceLink(id, url) {
    const el = document.getElementById(id);
    if (!el) return;
    const safe = safeExternalUrl(url);
    if (!safe) {
        el.setAttribute('href', '#');
        el.setAttribute('title', '');
        el.classList.add('disabled');
        el.classList.remove('multi');
        delete state.sourceLists[el.dataset?.signal || id];
        return;
    }
    el.classList.remove('disabled');
    el.classList.remove('multi');
    el.setAttribute('href', safe);
    el.setAttribute('title', safe);
}

function updateSourceLinks(data) {
    const articles = data?.news_intel?.articles;
    const sources = getArticleSources(articles, 8);
    const firstArticle = sources.length === 1 ? sources[0].url : getFirstArticleUrl(articles);

    const polymarketUrl = safeExternalUrl(data?.polymarket?.url) ||
        safeExternalUrl(data?.polymarket?.market_url) ||
        SOURCE_URLS.polymarket;

    setSourceLinkOrMenu('newsSource', 'News Intel', sources, firstArticle || 'https://www.bbc.com/news');
    setSourceLink('trendsSource', SOURCE_URLS.trends);
    setSourceLink('flightSource', SOURCE_URLS.aviation);
    setSourceLinkOrMenu('maritimeSource', 'Maritime NtM (Hormuz)', sources, firstArticle || SOURCE_URLS.maritime);
    setSourceLink('militarySource', SOURCE_URLS.military);
    setSourceLink('weatherSource', SOURCE_URLS.weather);
    // Stock markets: show exact per-ticker links when available.
    const marketSources = [];
    const tickerByRegion = { US: '^GSPC', ISRAEL: 'EIS', BITCOIN: 'BTC-USD', ETHEREUM: 'ETH-USD' };
    const marketData = data?.markets?.data;
    for (const region of Object.keys(tickerByRegion)) {
        const t = tickerByRegion[region];
        const url = `https://finance.yahoo.com/quote/${encodeURIComponent(t)}`;
        const change = marketData?.[region]?.change_percent;
        const changeText = Number.isFinite(Number(change)) ? ` (${Number(change).toFixed(2)}%)` : '';
        marketSources.push({ title: `${region} · ${t}${changeText}`, url });
    }
    setSourceLinkOrMenu('marketsSource', 'Stock Markets (Yahoo Finance)', marketSources, SOURCE_URLS.markets, true);
    setSourceLink('pentagonSource', SOURCE_URLS.pentagon);
    // Market odds: force a menu so users can see the exact URL (some mobile UIs hide "title" tooltips).
    const pmMarket = (data?.polymarket?.market || data?.polymarket?.question || '').toString().trim();
    setSourceLinkOrMenu(
        'polymarketSource',
        'Market Odds (Polymarket)',
        [{ title: pmMarket ? `Polymarket · ${pmMarket}` : 'Polymarket', url: polymarketUrl }],
        polymarketUrl,
        true
    );

    // Airspace NOTAMs: force a menu so the full source URL is visible/copyable.
    const airspaceUrl = safeExternalUrl(data?.airspace?.source_url) || SOURCE_URLS.airspace;
    const firCodes = Array.isArray(data?.airspace?.fir_codes) ? data.airspace.fir_codes.filter(Boolean) : [];
    const airTitle = firCodes.length ? `FAA NOTAM Search (FIR: ${firCodes.join(', ')})` : 'FAA NOTAM Search';
    setSourceLinkOrMenu('airspaceSource', 'Airspace NOTAMs', [{ title: airTitle, url: airspaceUrl }], airspaceUrl, true);
    setSourceLinkOrMenu('gpsSource', 'GPS/GNSS Interference', sources, firstArticle || 'https://www.gdeltproject.org/');
    setSourceLinkOrMenu('diplomatsSource', 'Diplomatic Posture', sources, firstArticle || 'https://www.state.gov/');
}

function setSourceLinkOrMenu(id, title, sources, fallbackUrl, forceMenuIfSingle = false) {
    const el = document.getElementById(id);
    if (!el) return;

    const list = Array.isArray(sources) ? sources.filter(s => safeExternalUrl(s?.url)) : [];
    const signalKey = el.dataset?.signal || id;

    if (list.length <= 1 && !forceMenuIfSingle) {
        if (list.length === 1) {
            state.sourceLists[signalKey] = list;
            setSourceLink(id, list[0].url);
        } else {
            delete state.sourceLists[signalKey];
            setSourceLink(id, fallbackUrl);
        }
        el.dataset.menuTitle = title;
        return;
    }

    // Multi-source: open scrollable menu instead of navigating directly.
    state.sourceLists[signalKey] = list;
    el.dataset.menuTitle = title;
    el.classList.remove('disabled');
    el.classList.add('multi');
    el.setAttribute('href', '#');
    el.setAttribute('title', 'Open sources');
}

function closeSourceMenu() {
    const menu = document.getElementById('sourceMenu');
    if (!menu) return;
    menu.classList.remove('open');
    menu.setAttribute('aria-hidden', 'true');
    menu.style.visibility = '';
    menu.style.left = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.bottom = '';
    menu.innerHTML = '';
}

function openSourceMenu(anchorEl, title, sources) {
    const menu = document.getElementById('sourceMenu');
    if (!menu) return;

    menu.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'source-menu-title';
    const headerText = document.createElement('span');
    headerText.textContent = title || 'Sources';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'source-menu-close';
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => closeSourceMenu());
    header.appendChild(headerText);
    header.appendChild(closeBtn);

    const list = document.createElement('div');
    list.className = 'source-menu-list';

    for (const s of (Array.isArray(sources) ? sources : [])) {
        const url = safeExternalUrl(s?.url);
        if (!url) continue;
        const a = document.createElement('a');
        a.className = 'source-menu-item';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';

        const t = document.createElement('div');
        t.className = 'source-menu-item-title';
        t.textContent = String(s?.title || 'Source').trim() || 'Source';

        const u = document.createElement('div');
        u.className = 'source-menu-item-url';
        u.textContent = url;

        a.appendChild(t);
        a.appendChild(u);
        list.appendChild(a);
    }

    menu.appendChild(header);
    menu.appendChild(list);

    // Make visible for measurement/positioning (then place and reveal).
    menu.classList.add('open');
    menu.setAttribute('aria-hidden', 'false');
    menu.style.visibility = 'hidden';

    const rect = anchorEl.getBoundingClientRect();
    const margin = 10;
    const menuRect = menu.getBoundingClientRect();

    // Prefer below the anchor, otherwise above, then clamp into viewport.
    let top = rect.bottom + margin;
    if (top + menuRect.height + margin > window.innerHeight) {
        top = rect.top - menuRect.height - margin;
    }

    let left = rect.left + rect.width / 2 - menuRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - menuRect.width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - menuRect.height - margin));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.right = '';
    menu.style.bottom = '';

    menu.style.visibility = 'visible';
}

function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        if (!lastUpdateTime) return;
        const elapsed = Math.floor((Date.now() - lastUpdateTime.getTime()) / 1000);
        const remaining = Math.max(0, 1800 - elapsed); // 30 minutes = 1800 seconds
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const nextEl = document.getElementById('nextUpdate');
        if (remaining > 0) {
            nextEl.textContent = `Next in ${mins}:${secs.toString().padStart(2, '0')}`;
        } else {
            nextEl.textContent = 'Updating...';
        }
    }, 1000);
}

function updateGauge(score) {
    score = Math.max(0, Math.min(100, Math.round(score)));
    // Deterministic jitter for gauge - all users see same value
    const seed = getTimeBasedSeed();
    const jitterVal = Math.floor(seededRandom(seed, 99) * 3) - 1;
    const displayScore = Math.max(0, Math.min(100, score + jitterVal));
    state.risk = displayScore;
    document.getElementById('gaugeFill').style.strokeDashoffset = 251.2 - (displayScore / 100 * 251.2);
    document.getElementById('gaugeFill').setAttribute('stroke', getGradient(displayScore));
    const val = document.getElementById('gaugeValue');
    val.textContent = `${displayScore}%`;
    val.className = `gauge-value ${getColor(displayScore)}`;
    const label = document.getElementById('statusLabel');
    label.textContent = getStatusText(displayScore);
    label.className = `status-label ${getStatusClass(displayScore)}`;
}

function updateSignal(name, value, detail) {
    const valEl = document.getElementById(`${name}Value`);
    const detailEl = document.getElementById(`${name}Detail`);
    if (!valEl) return;

    if (name === 'weather') {
        // Good weather = favorable for attack = higher risk
        // Show "Clear" (orange) when good, "Poor" (green) when bad
        const displayText = value === 'Favorable' ? 'Clear' : value === 'Marginal' ? 'Marginal' : 'Poor';
        valEl.textContent = displayText;
        const weatherColor = value === 'Favorable' ? 'var(--orange)' : value === 'Marginal' ? 'var(--yellow)' : 'var(--green)';
        valEl.style.color = weatherColor;
        // Update sparkline for weather - Clear (good attack conditions) = high, Poor = low
        const weatherNum = value === 'Favorable' ? 100 : value === 'Marginal' ? 50 : 20;
        const sparkColor = value === 'Favorable' ? '#f97316' : value === 'Marginal' ? '#eab308' : '#22c55e';
        updateSparkline(name, weatherNum, sparkColor);
    } else {
        // Deterministic jitter for signal display - all users see same
        let displayValue = Math.round(value) || 0;
        const seed = getTimeBasedSeed();
        const signalIndex = { news: 10, social: 11, flight: 12 }[name] || 13;
        const jitterVal = Math.floor(seededRandom(seed, signalIndex) * 5) - 2;
        displayValue = Math.max(0, Math.min(100, displayValue + jitterVal));
        const colorClass = getColor(displayValue);
        valEl.textContent = `${displayValue}%`;
        valEl.style.color = `var(--${colorClass})`;
        // Update sparkline with color based on value
        const sparkColor = getSparklineColor(displayValue);
        updateSparkline(name, displayValue, sparkColor);
    }
    if (detailEl) detailEl.textContent = detail;
}

function setIocLevel(signalName, level) {
    const valEl = document.getElementById(`${signalName}Value`);
    const item = valEl?.closest('.signal-item');
    if (!item) return;
    item.classList.remove('ioc-med', 'ioc-high');
    if (level === 'high') item.classList.add('ioc-high');
    else if (level === 'med') item.classList.add('ioc-med');
}

function setIocFromScore(signalName, score, med = 50, high = 70) {
    const n = toFiniteNumber(score, 0);
    if (n >= high) setIocLevel(signalName, 'high');
    else if (n >= med) setIocLevel(signalName, 'med');
    else setIocLevel(signalName, null);
}

function addFeed(source, text, isAlert = false, badge = null, tone = null, url = null) {
    const key = text.substring(0, 50).toLowerCase();
    if (state.seenHeadlines.has(key)) return;
    state.seenHeadlines.add(key);

    const item = { source, text, isAlert, badge, tone, url: safeExternalUrl(url), time: formatTime() };
    state.feedItems.unshift(item);
    if (state.feedItems.length > 20) state.feedItems.pop();
    renderFeed();
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderFeed() {
    const list = document.getElementById('feedList');
    const btn = document.getElementById('showMoreBtn');
    const expanded = list.classList.contains('expanded');
    const items = expanded ? state.feedItems : state.feedItems.slice(0, 3);

    list.innerHTML = items.map(i => `
        <div class="feed-item${i.isAlert ? ' alert' : ''}${i.tone === 'positive' ? ' positive' : ''}">
            <div class="feed-meta">
                <span class="feed-source-wrap">
                    <span class="feed-source">${escapeHtml(i.source)}${i.badge ? ` <span class="feed-badge">${escapeHtml(i.badge)}</span>` : ''}</span>
                    ${i.url ? `<a class="feed-link" href="${escapeHtml(i.url)}" target="_blank" rel="noopener noreferrer">Source ↗</a>` : ''}
                </span>
                <span class="feed-time">${i.time}</span>
            </div>
            <div class="feed-text">${escapeHtml(i.text)}</div>
        </div>
    `).join('');

    document.getElementById('feedCount').textContent = `${state.feedItems.length} items`;
    btn.style.display = state.feedItems.length > 3 ? 'block' : 'none';
    btn.textContent = expanded ? 'Show Less' : `Show All (${state.feedItems.length})`;
}

function toggleFeed() {
    const isExpanded = document.getElementById('feedList').classList.toggle('expanded');
    trackEvent('feed_toggle', 'engagement', isExpanded ? 'expanded' : 'collapsed');
    renderFeed();
}

function attachSourceMenuHandlers() {
    // Data signals source buttons (multi-source)
    document.addEventListener('click', (e) => {
        const a = e.target?.closest?.('a.source-btn.multi');
        if (!a) return;
        e.preventDefault();
        const key = a.dataset?.signal || a.id;
        const sources = state.sourceLists?.[key] || [];
        const title = a.dataset?.menuTitle || 'Sources';
        openSourceMenu(a, title, sources);
    });

    // Close menu on outside click / ESC
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('sourceMenu');
        if (!menu || !menu.classList.contains('open')) return;
        if (e.target?.closest?.('#sourceMenu')) return;
        if (e.target?.closest?.('a.source-btn.multi')) return;
        closeSourceMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSourceMenu();
    });

    window.addEventListener('resize', () => closeSourceMenu());
    // Only close on page scroll (not inner scroll inside the menu list).
    window.addEventListener('scroll', () => closeSourceMenu());
}

function initChart(historyData = null) {
    const canvas = document.getElementById('trendChart');
    const fallback = document.getElementById('trendChartFallback');
    if (!canvas) return;
    if (typeof Chart === 'undefined') {
        if (fallback) {
            fallback.style.display = 'flex';
            fallback.textContent = 'Chart unavailable';
        }
        return;
    }
    const ctx = canvas.getContext('2d');
    const now = new Date();

    // If we have real history data, use it
    if (historyData && historyData.length > 0) {
        // Filter to last 72 hours and sort by timestamp
        const cutoff = Date.now() - 72 * 60 * 60 * 1000;
        const validHistory = historyData
            .filter(h => h.timestamp > cutoff)
            .sort((a, b) => a.timestamp - b.timestamp);

        // Build labels and data from real history
        let lastDate = '';
        validHistory.forEach((h, i) => {
            const d = new Date(h.timestamp);
            const dateStr = formatDate(d);
            const hourStr = d.getHours().toString().padStart(2, '0') + ':00';

            let label;
            if (i === validHistory.length - 1) {
                label = 'Now';
            } else if (dateStr !== lastDate) {
                label = dateStr;
                lastDate = dateStr;
            } else {
                label = hourStr;
            }

            state.trendLabels.push(label);
            state.trendData.push(h.risk);
        });
    } else {
        // No history yet - show placeholder with "Building history..."
        state.trendLabels.push('Building history...');
        state.trendData.push(null);
    }

    chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: state.trendLabels,
            datasets: [{
                data: state.trendData,
                borderColor: '#f97316',
                backgroundColor: 'rgba(249, 115, 22, 0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 4,
                pointBackgroundColor: '#f97316',
                pointBorderColor: '#fff',
                pointBorderWidth: 1,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1c1c1c',
                    titleColor: '#fff',
                    bodyColor: '#999',
                    borderColor: '#333',
                    borderWidth: 1,
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        title: (ctx) => ctx[0].label,
                        label: (ctx) => `Risk: ${Math.round(ctx.raw)}%`
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#666', font: { size: 10 } }
                },
                y: {
                    min: 0,
                    max: 100,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#666', font: { size: 10 }, stepSize: 25, callback: v => v + '%' }
                }
            }
        }
    });

    const originalDraw = chart.draw;
    chart.draw = function () {
        originalDraw.apply(this, arguments);
        const ctx = this.ctx;
        const yAxis = this.scales.y;
        const xAxis = this.scales.x;
        const y = yAxis.getPixelForValue(15);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(xAxis.left, y);
        ctx.lineTo(xAxis.right, y);
        ctx.stroke();
        ctx.fillStyle = '#555';
        ctx.font = '10px Inter';
        ctx.fillText('Normal', xAxis.left + 5, y - 5);
        ctx.restore();
    };
}

function showInfo(type) {
    trackEvent('info_click', 'engagement', type);
    safeGtagEvent('view_item', {
        item_id: type,
        item_name: INFO_CONTENT[type].title
    });
    const info = INFO_CONTENT[type];
    document.getElementById('infoTitle').textContent = info.title;
    document.getElementById('infoBody').innerHTML = info.body;
    document.getElementById('infoModal').classList.add('open');
}
function closeInfo(e) { if (!e || e.target.id === 'infoModal') document.getElementById('infoModal').classList.remove('open'); }

function shareSnapshot() {
    trackEvent('share', 'engagement', 'snapshot_shared', state.risk);
    const text = `BetterLife - War Risk Monitor\n\n` +
        `📊 Projected Risk (8h): ${state.risk}% (${getStatusText(state.risk)})\n` +
        `⏱️ Window: Next 8 Hours\n\n` +
        `📰 News: ${document.getElementById('newsValue').textContent}\n` +
        `📈 Interest: ${document.getElementById('socialValue').textContent}\n` +
        `✈️ Aviation: ${document.getElementById('flightValue').textContent}\n` +
        `🎯 Military: ${document.getElementById('militaryValue')?.textContent || '--'}\n` +
        `🌤️ Conditions: ${document.getElementById('weatherValue').textContent}\n` +
        `🛰️ GPS/GNSS: ${document.getElementById('gpsValue')?.textContent || '--'}\n` +
        `🏛️ Diplomats: ${document.getElementById('diplomatsValue')?.textContent || '--'}\n\n` +
        `🔗 https://{PLACEHOLDER}.github.io/{placeholder}`;

    if (navigator.share) {
        navigator.share({ title: 'BetterLife', text });
        trackEvent('share', 'engagement', 'native_share', state.risk);
    } else {
        navigator.clipboard.writeText(text).then(() => {
            alert('Copied to clipboard!');
            trackEvent('share', 'engagement', 'clipboard_copy', state.risk);
        });
    }
}

// SIGNAL 1: NEWS INTEL - Uses cached data from GitHub Action (Max 30%)
// News is now fetched server-side to avoid CORS proxy inconsistencies
async function fetchNews() {
    try {
        setStatus('newsStatus', true);

        // First, try to get cached news from npoint.io (set by GitHub Action)
        let articles = 0;
        let alertCount = 0;
        let newsArticles = [];

        try {
            const cb = Math.floor(Date.now() / 60000);
            const cacheRes = await fetch(`https://api.npoint.io/${API_KEYS.npoint}?cb=${cb}`, { cache: 'no-store' });
            if (cacheRes.ok) {
                const cache = await cacheRes.json();
                if (cache.news_intel && cache.news_intel.articles) {
                    newsArticles = cache.news_intel.articles;
                    articles = cache.news_intel.total_count || newsArticles.length;
                    alertCount = cache.news_intel.alert_count || 0;

                    // Add articles to feed
                    newsArticles.slice(0, 8).forEach(a => {
                        const title = (a.title || '').substring(0, 80);
                        addFeed('NEWS', title, a.is_alert, a.is_alert ? 'Alert' : null);
                    });

                    console.log(`News Intel from cache: ${articles} articles, ${alertCount} alerts`);
                }
            }
        } catch (e) {
            console.log('Cache read failed, using fallback');
        }

        // If no cached data, use fallback baseline
        if (articles === 0) {
            console.log('No cached news data, using baseline');
            updateSignal('news', 10, 'Awaiting data...');
            return 3; // baseline contribution
        }

        // Calculate contribution based on article count and alerts
        // With 2 RSS feeds (BBC + Al Jazeera), typical Iran articles = 0-10
        let contribution = 2; // baseline
        if (articles === 0) {
            contribution = 2;
        } else if (articles <= 3) {
            contribution = 3 + articles * 2 + alertCount * 1;
        } else if (articles <= 6) {
            contribution = 9 + (articles - 3) * 1.5 + alertCount * 1.5;
        } else if (articles <= 10) {
            contribution = 13.5 + (articles - 6) * 1 + alertCount * 2;
        } else {
            contribution = 17.5 + (articles - 10) * 0.5 + alertCount * 2;
        }

        contribution = Math.min(30, contribution);
        const displayRisk = Math.round((contribution / 30) * 100);
        updateSignal('news', displayRisk, `${articles} articles, ${alertCount} critical`);
        return contribution;

    } catch (e) {
        console.log('News fetch error:', e.message);
        setStatus('newsStatus', false);
        updateSignal('news', 6, 'Feed error - using baseline');
        return 2;
    }
}

// SIGNAL 2: PUBLIC INTEREST - GDELT + Wikipedia (Max 25%)
async function fetchPublicInterest() {
    let gdeltArticles = 0;
    let gdeltTone = 0;
    let wikiViews = 0;
    let gdeltWorked = false;
    let wikiWorked = false;

    try {
        const gdeltQuery = encodeURIComponent('iran attack OR iran strike OR iran military OR iran us');
        const gdeltUrl = `https://api.gdeltproject.org/api/v2/doc/doc?query=${gdeltQuery}&mode=artlist&maxrecords=50&format=json&timespan=24h`;
        const gdeltRes = await fetch(gdeltUrl);
        if (gdeltRes.ok) {
            const text = await gdeltRes.text();
            // GDELT sometimes returns error messages instead of JSON
            if (text.startsWith('{') || text.startsWith('[')) {
                const gdeltData = JSON.parse(text);
                if (gdeltData.articles && Array.isArray(gdeltData.articles)) {
                    gdeltArticles = gdeltData.articles.length;
                    const tones = gdeltData.articles.map(a => a.tone || 0).filter(t => t !== 0);
                    if (tones.length > 0) {
                        gdeltTone = tones.reduce((a, b) => a + b, 0) / tones.length;
                    }
                    gdeltWorked = true;
                    if (gdeltData.articles[0]) {
                        const title = (gdeltData.articles[0].title || '').substring(0, 70);
                        const isNegative = gdeltTone < -3;
                        addFeed('GDELT', title, isNegative, isNegative ? 'Alert' : null);
                    }
                }
            }
        }
    } catch (e) { /* GDELT unavailable - will use Wikipedia only */ }

    try {
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0].replace(/-/g, '');
        const pages = ['Iran', 'Iran%E2%80%93United_States_relations', 'Iran%E2%80%93Israel_conflict'];
        let totalViews = 0;

        for (const page of pages) {
            try {
                const res = await fetch(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${page}/daily/${yesterday}/${yesterday}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.items?.[0]) {
                        totalViews += data.items[0].views;
                        wikiWorked = true;
                    }
                }
            } catch (e) { }
        }
        wikiViews = totalViews;
    } catch (e) { }

    setStatus('trendsStatus', gdeltWorked || wikiWorked);

    let gdeltRisk = 0;
    let wikiRisk = 0;

    if (gdeltWorked) {
        if (gdeltArticles <= 10) {
            gdeltRisk = 1 + gdeltArticles * 0.2;
        } else if (gdeltArticles <= 25) {
            gdeltRisk = 3 + (gdeltArticles - 10) * 0.27;
        } else {
            gdeltRisk = 7 + (gdeltArticles - 25) * 0.2;
        }
        if (gdeltTone < -5) gdeltRisk += 3;
        else if (gdeltTone < -3) gdeltRisk += 1.5;
        gdeltRisk = Math.min(12, gdeltRisk);
    }

    if (wikiWorked && wikiViews > 0) {
        if (wikiViews < 20000) {
            wikiRisk = 1 + (wikiViews / 15000);
        } else if (wikiViews < 50000) {
            wikiRisk = 2.5 + ((wikiViews - 20000) / 10000);
        } else if (wikiViews < 100000) {
            wikiRisk = 5.5 + ((wikiViews - 50000) / 8000);
        } else {
            wikiRisk = 12 + ((wikiViews - 100000) / 50000);
        }
        wikiRisk = Math.min(13, wikiRisk);

        if (wikiViews > 80000) {
            addFeed('WIKI', `Iran pages: ${Math.round(wikiViews / 1000)}k views (elevated)`, true, 'Spike');
        }
    }

    const totalRisk = Math.min(25, gdeltRisk + wikiRisk + 1);
    const displayRisk = Math.round((totalRisk / 25) * 100);

    let detail = '';
    if (gdeltWorked) detail += `${gdeltArticles} GDELT`;
    if (wikiWorked) detail += (detail ? ', ' : '') + `${Math.round(wikiViews / 1000)}k Wiki`;
    if (!detail) detail = 'Monitoring...';

    updateSignal('social', displayRisk, detail);
    return totalRisk;
}

// SIGNAL 3: AVIATION - Iran Airspace Activity (Max 35%)
// Uses OpenSky Network API - counts aircraft in Iran airspace in real-time
async function fetchAviation() {
    try {
        setStatus('flightStatus', true);

        // Iran airspace bounding box (covers Tehran and surrounding area)
        // lat 25-40, lon 44-64 covers most of Iran
        const url = `https://opensky-network.org/api/states/all?lamin=25&lomin=44&lamax=40&lomax=64`;

        const res = await fetch(url);
        if (!res.ok) {
            throw new Error('OpenSky API error');
        }

        const data = await res.json();
        let civilCount = 0;
        let airlines = [];

        if (data.states && Array.isArray(data.states)) {
            data.states.forEach(aircraft => {
                const icao = aircraft[0]; // ICAO24 hex
                const callsign = (aircraft[1] || '').trim();
                const onGround = aircraft[8];

                // Skip aircraft on ground
                if (onGround) return;

                // Skip military (US military ICAO range)
                const icaoNum = parseInt(icao, 16);
                const usafHexStart = parseInt('AE0000', 16);
                const usafHexEnd = parseInt('AE7FFF', 16);
                if (icaoNum >= usafHexStart && icaoNum <= usafHexEnd) return;

                // Count as civil aviation
                civilCount++;

                // Extract airline code from callsign (first 3 letters usually)
                if (callsign && callsign.length >= 3) {
                    const airlineCode = callsign.substring(0, 3);
                    if (!airlines.includes(airlineCode)) {
                        airlines.push(airlineCode);
                    }
                }
            });
        }

        // Risk logic: Normal traffic = 20-50 aircraft over Iran
        // Lower than normal = concerning (airlines avoiding area)
        // Much lower = high risk
        let contribution = 0;

        if (civilCount === 0) {
            contribution = 30; // Zero flights = very concerning
            addFeed('AVIATION', `⚠️ No aircraft detected over Iran airspace`, true, 'Warning');
        } else if (civilCount < 5) {
            contribution = 25; // Very low traffic
            addFeed('AVIATION', `⚠️ Very low traffic: ${civilCount} aircraft over Iran`, true, 'Alert');
        } else if (civilCount < 15) {
            contribution = 15; // Below normal
        } else if (civilCount < 30) {
            contribution = 8; // Slightly below normal
        } else {
            contribution = 3; // Normal/good traffic
        }

        const displayRisk = Math.round((contribution / 35) * 100);
        const detail = `${civilCount} aircraft over Iran`;
        updateSignal('flight', displayRisk, detail);

        if (civilCount >= 15) {
            addFeed('AVIATION', `${civilCount} commercial aircraft in Iran airspace (${airlines.length} airlines)`);
        }

        return contribution;

    } catch (e) {
        console.log('Aviation API error:', e.message);
        setStatus('flightStatus', false);
        updateSignal('flight', 15, 'Scanning...');
        return 5; // Baseline when API fails
    }
}

// SIGNAL: MILITARY TRACKERS (Max 15%)
// Heuristic OSINT from OpenSky ADS-B over a wider regional box (Levant/Iraq/Gulf/Iran)
async function fetchMilitaryTrackers() {
    try {
        setStatus('militaryStatus', true);

        const url = `https://opensky-network.org/api/states/all?lamin=15&lomin=34&lamax=42&lomax=64`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('OpenSky API error');

        const data = await res.json();
        let militaryCount = 0;
        let tankerLike = 0;

        const usafHexStart = parseInt('AE0000', 16);
        const usafHexEnd = parseInt('AE7FFF', 16);
        const tankerRe = /\b(TEXACO|SHELL|MOOSE|TEAM|GOLD|NACHO|ARCO)\b/i;

        if (data.states && Array.isArray(data.states)) {
            data.states.forEach(aircraft => {
                const icao = aircraft[0];
                const callsign = (aircraft[1] || '').trim();
                const onGround = aircraft[8];
                if (onGround || !icao) return;

                const icaoNum = parseInt(icao, 16);
                const isUsMil = Number.isFinite(icaoNum) && icaoNum >= usafHexStart && icaoNum <= usafHexEnd;
                if (!isUsMil && !tankerRe.test(callsign)) return;

                militaryCount++;
                if (tankerRe.test(callsign)) tankerLike++;
            });
        }

        let contribution = 1; // baseline
        if (militaryCount > 0) {
            contribution = 1 + militaryCount * 2 + tankerLike * 1.5;
        }
        contribution = Math.min(15, contribution);

        const displayRisk = Math.min(100, Math.round((contribution / 15) * 100));
        const detail = militaryCount === 0
            ? 'No tracked assets detected'
            : `${militaryCount} tracked assets${tankerLike ? ` (${tankerLike} tanker-like)` : ''}`;

        updateSignal('military', displayRisk, detail);

        if (militaryCount >= 3) addFeed('MIL', `🎯 Increased tracked military activity (${militaryCount})`, true, 'Alert');
        else if (militaryCount > 0) addFeed('MIL', `🎯 Tracked military activity (${militaryCount})`);

        return contribution;
    } catch (e) {
        console.log('Military trackers error:', e.message);
        setStatus('militaryStatus', false);
        updateSignal('military', 10, 'Awaiting data...');
        return 1;
    }
}

// SIGNAL 4: AIRSPACE NOTAMs (Max 15%)
// Fetched server-side by strikeraedar.py
async function fetchAirspace() {
    setStatus('airspaceStatus', true);
    return 10; // Baseline - real value comes from cache
}

// SIGNAL 5: STOCK MARKETS (Max 15%)
// Fetched server-side by strikeraedar.py
async function fetchMarkets() {
    setStatus('marketsStatus', true);
    return 10; // Baseline - real value comes from cache
}

// SIGNAL: OPERATIONAL CONDITIONS (Weather in Tehran) (Max 5%)
async function fetchWeather() {
    try {
        const lat = 35.6892;
        const lon = 51.3890;
        const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${API_KEYS.openweather}&units=metric`;

        const res = await fetch(url);
        if (!res.ok) throw new Error('OpenWeather API error');
        const data = await res.json();

        const clouds = toFiniteNumber(data?.clouds?.all, 100); // %
        const wind = toFiniteNumber(data?.wind?.speed, 0); // m/s
        const visibility = toFiniteNumber(data?.visibility, 10000); // meters
        const precip = toFiniteNumber(data?.rain?.['1h'], 0) + toFiniteNumber(data?.snow?.['1h'], 0); // mm/h
        const tempC = toFiniteNumber(data?.main?.temp, null);

        const favorable = clouds <= 30 && wind <= 7 && precip <= 0.2 && visibility >= 8000;
        const marginal = clouds <= 60 && wind <= 10 && precip <= 1 && visibility >= 4000;

        const condition = favorable ? 'Favorable' : marginal ? 'Marginal' : 'Poor';
        const contribution = condition === 'Favorable' ? 5 : condition === 'Marginal' ? 3 : 1;

        const parts = [];
        if (tempC !== null) parts.push(`${Math.round(tempC)}°C`);
        parts.push(`clouds ${Math.round(clouds)}%`);
        if (precip > 0) parts.push(`precip ${precip.toFixed(1)}mm/h`);
        if (visibility !== 10000) parts.push(`vis ${Math.round(visibility / 1000)}km`);
        const detail = `Tehran: ${parts.join(', ')}`;

        updateSignal('weather', condition, detail);
        setStatus('weatherStatus', true);
        return { contribution, condition, detail, fetched: true };
    } catch (e) {
        console.log('Weather API error:', e.message);
        setStatus('weatherStatus', false);
        updateSignal('weather', 'Poor', 'Weather unavailable');
        return { contribution: 1, condition: 'Poor', detail: 'Weather unavailable', fetched: false };
    }
}

// SIGNAL: POLYMARKET ODDS (Max 10%)
// Note: Real data is fetched by GitHub Action and stored in npoint.io cache
// This function returns baseline - actual display comes from cached data in displayData()
async function fetchPolymarket() {
    // Polymarket data is fetched server-side by GitHub Action every 30 min
    // and stored in npoint.io cache. We just return baseline here.
    // The displayData() function will read the cached polymarket odds.
    setStatus('polymarketStatus', true);
    return 1; // Baseline - real value comes from cache
}

// Deterministic jitter based on current time window (all users see same values)
// Changes every 30 minutes when data refreshes
function getTimeBasedSeed() {
    // Round to nearest 30-minute window
    const base = toFiniteNumber(state.cacheSeedMs, Date.now());
    return Math.floor(base / (30 * 60 * 1000));
}

// Simple seeded random (deterministic based on seed + index)
function seededRandom(seed, index) {
    const x = Math.sin(seed + index * 9999) * 10000;
    return x - Math.floor(x);
}

// Apply deterministic jitter - same for all users at same time
function applyJitter(value, min = 0, max = 100, range = 2, index = 0) {
    const seed = getTimeBasedSeed();
    const random = seededRandom(seed, index);
    const jitterAmount = Math.floor(random * (range * 2 + 1)) - range;
    const base = toFiniteNumber(value, min);
    return Math.max(min, Math.min(max, base + jitterAmount));
}

// npoint.io cache functions (free, no rate limits!)
const NPOINT_ID = API_KEYS.npoint;

function cacheBustValue() {
    const build = (typeof window !== 'undefined' && window.__BUILD_ID__) ? String(window.__BUILD_ID__) : 'dev';
    return `${Date.now()}-${build}`;
}

async function getCache() {
    try {
        // Best-effort cache busting across browsers/CDNs.
        const cb = cacheBustValue();
        const res = await fetch(`https://api.npoint.io/${NPOINT_ID}?cb=${encodeURIComponent(cb)}`, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        });
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        console.log('Cache read error:', e.message);
    }
    return null;
}

async function setCache(data, totalRisk = null) {
    try {
        if (!ALLOW_SHARED_CACHE_WRITE) return;

        // Get existing cache to preserve history AND GitHub Action data
        const existing = await getCache();
        let history = (existing && existing.history) ? existing.history : [];
        let signalHistoryCache = (existing && existing.signalHistory) ? existing.signalHistory : {
            news: [], social: [], flight: [], maritime: [], military: [], markets: [], pentagon: [], polymarket: [], airspace: [], weather: [], gps: [], diplomats: []
        };

        // IMPORTANT: Preserve GitHub Action data (polymarket, pentagon, news_intel)
        // These are set by the server-side script and should not be overwritten
        if (existing) {
            if (existing.polymarket) data.polymarket = existing.polymarket;
            if (existing.pentagon) data.pentagon = existing.pentagon;
            if (existing.news_intel) data.news_intel = existing.news_intel;
            if (existing.markets) data.markets = existing.markets;
            if (existing.airspace) data.airspace = existing.airspace;
            if (existing.pentagon_updated) data.pentagon_updated = existing.pentagon_updated;
        }

        // Add new history point if we have a risk value
        if (totalRisk !== null) {
            history.push({
                timestamp: Date.now(),
                risk: totalRisk
            });

            // Keep only last 72 hours of history (max ~144 points at 30-min intervals)
            const cutoff = Date.now() - 72 * 60 * 60 * 1000;
            history = history.filter(h => h.timestamp > cutoff);

            // Add signal values to signal history (for sparklines)
            if (data.signalValues) {
                ['news', 'social', 'flight', 'maritime', 'military', 'markets', 'polymarket', 'airspace', 'weather', 'gps', 'diplomats'].forEach(sig => {
                    if (data.signalValues[sig] !== undefined) {
                        signalHistoryCache[sig] = signalHistoryCache[sig] || [];
                        signalHistoryCache[sig].push(data.signalValues[sig]);
                        // Keep only last 20 points
                        if (signalHistoryCache[sig].length > 20) {
                            signalHistoryCache[sig] = signalHistoryCache[sig].slice(-20);
                        }
                    }
                });
            }

            // Handle pentagon separately from cached data
            if (data.pentagon && data.pentagon.score !== undefined) {
                const pentagonDisplay = Math.round((data.pentagon.score < 40 ? 10 :
                    data.pentagon.score <= 60 ? 20 + (data.pentagon.score - 40) :
                        data.pentagon.score <= 80 ? 40 + (data.pentagon.score - 60) * 1.5 :
                            70 + (data.pentagon.score - 80) * 1.5));
                signalHistoryCache.pentagon = signalHistoryCache.pentagon || [];
                signalHistoryCache.pentagon.push(Math.min(100, pentagonDisplay));
                if (signalHistoryCache.pentagon.length > 20) {
                    signalHistoryCache.pentagon = signalHistoryCache.pentagon.slice(-20);
                }
            }
        }

        // Save data with history
        data.history = history;
        data.signalHistory = signalHistoryCache;

        await fetch(`https://api.npoint.io/${NPOINT_ID}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
    } catch (e) {
        console.log('Cache write error:', e.message);
    }
}

// Fetch fresh data from all APIs
async function fetchFreshData() {
    // Clear feed for fresh fetch
    state.feedItems = [];
    state.seenHeadlines.clear();

    // First, get cached data for polymarket and pentagon (set by GitHub Action)
    let cachedData = {};
    try {
        const cb = Math.floor(Date.now() / 60000);
        const cacheRes = await fetch(`https://api.npoint.io/${API_KEYS.npoint}?cb=${cb}`, { cache: 'no-store' });
        if (cacheRes.ok) {
            cachedData = await cacheRes.json();
        }
    } catch (e) {
        console.log('Cache fetch error:', e.message);
    }

    const [news, interest, aviation, military, markets, polymarket, airspace, weatherResult] = await Promise.all([
        fetchNews(),
        fetchPublicInterest(),
        fetchAviation(),
        fetchMilitaryTrackers(),
        fetchMarkets(),
        fetchPolymarket(),
        fetchAirspace(),
        fetchWeather()
    ]);

    // OSINT signals derived from the cached news batch (server-side)
    const osint = analyzeOsintFromArticles(cachedData.news_intel?.articles);
    const gpsContribution = toFiniteNumber(osint?.gps?.contribution, OSINT_SIGNALS.gps.baseline);
    const diplomatsContribution = toFiniteNumber(osint?.diplomats?.contribution, OSINT_SIGNALS.diplomats.baseline);
    const maritimeContribution = toFiniteNumber(cachedData?.maritime_ntm?.score, toFiniteNumber(osint?.maritime?.contribution, OSINT_SIGNALS.maritime.baseline));

    const weatherContribution = toFiniteNumber(weatherResult?.contribution, 1);

    // Calculate display values for sparklines
    const newsDisplay = Math.round((Number(news) || 0) / 30 * 100);
    const socialDisplay = Math.round((Number(interest) || 0) / 20 * 100);
    const flightDisplay = Math.round((Number(aviation) || 0) / 15 * 100);
    const militaryDisplay = Math.round((Number(military) || 0) / 15 * 100);
    let marketsDisplay = 10;
    if (cachedData.markets?.data) {
        const usChange = toFiniteNumber(cachedData.markets.data.US?.change_percent, 0);
        const ilChange = toFiniteNumber(cachedData.markets.data.ISRAEL?.change_percent, 0);
        const btcChange = toFiniteNumber(cachedData.markets.data.BITCOIN?.change_percent, 0);
        const ethChange = toFiniteNumber(cachedData.markets.data.ETHEREUM?.change_percent, 0);

        const scoreFromChange = (change, thresholds) => {
            for (const [limit, score] of thresholds) {
                if (change <= limit) return score;
            }
            return 0;
        };

        const usScore = scoreFromChange(usChange, [[-2.0, 6], [-1.0, 4], [-0.5, 2]]);
        const ilScore = scoreFromChange(ilChange, [[-2.5, 6], [-1.2, 4], [-0.6, 2]]);
        const btcScore = scoreFromChange(btcChange, [[-6.0, 8], [-3.0, 6], [-1.5, 4], [-0.7, 2]]);
        const ethScore = scoreFromChange(ethChange, [[-7.0, 7], [-4.0, 5], [-2.0, 3], [-1.0, 2]]);
        const contribution = Math.min(15, usScore + ilScore + btcScore + ethScore);
        marketsDisplay = Math.min(100, Math.round((contribution / 15) * 100));
    }
    const polymarketOdds = cachedData.polymarket?.odds || 0;
    const polymarketDisplay = polymarketOdds; // Direct percentage
    const airspaceDisplay = cachedData.airspace?.score ? Math.min(100, cachedData.airspace.score * 2) : 10;
    const weatherDisplay = weatherContribution >= 4.5 ? 100 : weatherContribution >= 2.5 ? 55 : 20;
    const gpsDisplay = Math.min(100, Math.round((gpsContribution / OSINT_SIGNALS.gps.maxContribution) * 100));
    const diplomatsDisplay = Math.min(100, Math.round((diplomatsContribution / OSINT_SIGNALS.diplomats.maxContribution) * 100));
    const maritimeDisplay = Math.min(100, Math.round((maritimeContribution / OSINT_SIGNALS.maritime.maxContribution) * 100));

    return {
        news: Number(news) || 0,
        interest: Number(interest) || 0,
        aviation: Number(aviation) || 0,
        maritime: maritimeContribution,
        maritimeDetail: cachedData?.maritime_ntm?.detail || osint?.maritime?.detail || 'Awaiting data...',
        military: Number(military) || 0,
        tanker: 0, // Deprecated
        weather: weatherContribution,
        weatherCondition: weatherResult?.condition || null,
        weatherDetail: weatherResult?.detail || null,
        weatherFetched: !!weatherResult?.fetched,
        gps: gpsContribution,
        gpsDetail: osint?.gps?.detail || 'Awaiting data...',
        diplomats: diplomatsContribution,
        diplomatsDetail: osint?.diplomats?.detail || 'Awaiting data...',
        timestamp: Date.now(),
        // Include cached server-side data
        news_intel: cachedData.news_intel || null,
        polymarket: cachedData.polymarket || null,
        pentagon: cachedData.pentagon || null,
        markets: cachedData.markets || null,
        airspace: cachedData.airspace || null,
        maritime_ntm: cachedData.maritime_ntm || null,
        // Store history from cache
        history: cachedData.history || [],
        signalHistory: cachedData.signalHistory || {},
        // Store details for cache
        newsDetail: document.getElementById('newsDetail').textContent,
        socialDetail: document.getElementById('socialDetail').textContent,
        flightDetail: document.getElementById('flightDetail').textContent,
        militaryDetail: document.getElementById('militaryDetail').textContent,
        marketsDetail: document.getElementById('marketsDetail').textContent,
        polymarketDetail: document.getElementById('polymarketDetail').textContent,
        airspaceDetail: document.getElementById('airspaceDetail').textContent,
        feedItems: state.feedItems.slice(0, 10), // Store top 10 feed items
        // Store signal display values for sparkline history
        signalValues: {
            news: newsDisplay,
            social: socialDisplay,
            flight: flightDisplay,
            maritime: maritimeDisplay,
            military: militaryDisplay,
            markets: marketsDisplay,
            polymarket: polymarketDisplay,
            airspace: airspaceDisplay,
            weather: weatherDisplay,
            gps: gpsDisplay,
            diplomats: diplomatsDisplay
        }
        // Note: history is managed separately in setCache
    };
}

// Display data on the dashboard
function displayData(data, fromCache = false) {
    state.cacheSeedMs = toFiniteNumber(data?.strikeraedar_updated_ms, toFiniteNumber(data?.timestamp, toFiniteNumber(state.cacheSeedMs, Date.now())));

    // Defensive parsing: cache can be partially populated (or overwritten) and must not produce NaN UI.
    let safeNews = applyJitter(toFiniteNumber(data.news, 3), 0, 30, 1, 1);
    let safeInterest = applyJitter(toFiniteNumber(data.interest, 5), 0, 20, 1, 2);
    let safeAviation = applyJitter(toFiniteNumber(data.aviation, state.lastKnown?.aviation?.value ?? 5), 0, 15, 1, 3);
    const safeMarkets = 0; // Handled separately
    const safePolymarket = applyJitter(data.polymarket || 0, 0, 10, 1, 5);
    const safeAirspace = 0; // Handled separately

    // Load signal history from cache if available
    if (data.signalHistory) {
        ['news', 'social', 'flight', 'maritime', 'military', 'markets', 'pentagon', 'polymarket', 'airspace', 'weather', 'gps', 'diplomats'].forEach(sig => {
            if (data.signalHistory[sig] && data.signalHistory[sig].length > 0) {
                state.signalHistory[sig] = data.signalHistory[sig];
            }
        });
    }

    // Update individual signal displays with stored details or computed values
    // NEWS: Use news_intel from GitHub Action cache if available (consistent for all users)
    let newsDisplayRisk = Math.round((safeNews / 30) * 100);
    let newsDetail = `${Math.round(safeNews / 2)} articles, ${Math.round(safeNews / 10)} critical`;

    if (data.news_intel && data.news_intel.total_count !== undefined) {
        // Use server-side cached news data (consistent!)
        const articles = toFiniteNumber(data.news_intel.total_count, 0);
        const alertCount = toFiniteNumber(data.news_intel.alert_count, 0);

        // Calculate contribution (same formula as fetchNews)
        let contribution = 2;
        if (articles <= 3) {
            contribution = 3 + articles * 2 + alertCount * 1;
        } else if (articles <= 6) {
            contribution = 9 + (articles - 3) * 1.5 + alertCount * 1.5;
        } else if (articles <= 10) {
            contribution = 13.5 + (articles - 6) * 1 + alertCount * 2;
        } else {
            contribution = 17.5 + (articles - 10) * 0.5 + alertCount * 2;
        }
        contribution = Math.min(30, contribution);

        // Use the server-side derived contribution for totals too (prevents NaN/0 when client cache was overwritten).
        safeNews = contribution;
        newsDisplayRisk = Math.round((contribution / 30) * 100);
        newsDetail = `${articles} articles, ${alertCount} critical`;
    } else if (data.newsDetail && !data.newsDetail.includes('Monitoring') && !data.newsDetail.includes('Loading') && !data.newsDetail.includes('Awaiting')) {
        newsDetail = data.newsDetail;
    }

    updateSignal('news', newsDisplayRisk, newsDetail);
    if (data.news_intel && data.news_intel.alert_count !== undefined) {
        const alertCount = toFiniteNumber(data.news_intel.alert_count, 0);
        if (alertCount >= 2) setIocLevel('news', 'high');
        else if (alertCount >= 1) setIocLevel('news', 'med');
        else setIocLevel('news', null);
    } else {
        setIocLevel('news', null);
    }

    updateSignal('social', Math.round((safeInterest / 20) * 100), data.socialDetail || 'GDELT + Wikipedia');

    // OSINT (derived from latest cached news batch when available)
    const osint = analyzeOsintFromArticles(data?.news_intel?.articles);
    const osintLive = !!osint?.hasData;

    const flightCount = Math.round(safeAviation * 10);
    const flightDetail = (data.flightDetail && !data.flightDetail.includes('Scanning') && !data.flightDetail.includes('Loading')) ? data.flightDetail : `${flightCount} aircraft over Iran`;
    updateSignal('flight', Math.round((safeAviation / 15) * 100), flightDetail);
    setIocFromScore('flight', Math.round((safeAviation / 15) * 100), 55, 75);

    // MARITIME NTM (Hormuz) (OSINT)
    const maritimeFromServer = !!data?.maritime_ntm;
    const maritimeCount = maritimeFromServer ? toFiniteNumber(data?.maritime_ntm?.count, 0) : (osintLive ? toFiniteNumber(osint?.maritime?.count, 0) : 0);
    const maritimeCritical = maritimeFromServer ? toFiniteNumber(data?.maritime_ntm?.critical, 0) : (osintLive ? toFiniteNumber(osint?.maritime?.critical, 0) : 0);

    let maritimeContribution = toFiniteNumber(data.maritime, osint?.maritime?.contribution ?? OSINT_SIGNALS.maritime.baseline);
    if (maritimeFromServer && data?.maritime_ntm?.score !== undefined) {
        maritimeContribution = toFiniteNumber(data.maritime_ntm.score, maritimeContribution);
    }
    maritimeContribution = Math.max(0, Math.min(OSINT_SIGNALS.maritime.maxContribution, maritimeContribution));
    const maritimeDetail = data.maritimeDetail || data?.maritime_ntm?.detail || osint?.maritime?.detail || 'Awaiting data...';
    const maritimeDisplay = Math.min(100, Math.round((maritimeContribution / OSINT_SIGNALS.maritime.maxContribution) * 100));
    updateSignal('maritime', maritimeDisplay, maritimeDetail);
    setStatus('maritimeStatus', maritimeFromServer || osintLive);
    if (maritimeCritical >= 1 || maritimeContribution >= 9) setIocLevel('maritime', 'high');
    else if (maritimeCount >= 1 || maritimeContribution >= 5) setIocLevel('maritime', 'med');
    else setIocLevel('maritime', null);

    if (!fromCache && (maritimeFromServer || osintLive) && maritimeCritical >= 1) {
        addFeed('MARITIME', '🚢 Maritime advisory/warning activity detected near Strait of Hormuz', true, 'Alert');
    }

    // MILITARY (client-side heuristic)
    const safeMilitary = applyJitter(toFiniteNumber(data.military, 1), 0, 15, 1, 7);
    const militaryDetail = (data.militaryDetail && !data.militaryDetail.includes('Awaiting') && !data.militaryDetail.includes('Loading')) ? data.militaryDetail : 'Monitoring...';
    updateSignal('military', Math.round((safeMilitary / 15) * 100), militaryDetail);
    setStatus('militaryStatus', data?.military !== undefined || !!data?.militaryDetail);
    setIocFromScore('military', Math.round((safeMilitary / 15) * 100), 45, 70);

    // WEATHER (client-side)
    const safeWeather = applyJitter(toFiniteNumber(data.weather, 1), 0, 5, 1, 6);
    let weatherCondition = 'Poor';
    if (safeWeather >= 4.5) weatherCondition = 'Favorable';
    else if (safeWeather >= 2.5) weatherCondition = 'Marginal';
    const weatherDetail = data.weatherDetail || (weatherCondition === 'Favorable' ? 'Clear conditions' : weatherCondition === 'Marginal' ? 'Mixed conditions' : 'Unfavorable conditions');
    updateSignal('weather', data.weatherCondition || weatherCondition, weatherDetail);
    const weatherLive = (data.weatherFetched === undefined) ? true : !!data.weatherFetched;
    setStatus('weatherStatus', weatherLive);

    let gpsContribution = toFiniteNumber(data.gps, osint?.gps?.contribution ?? OSINT_SIGNALS.gps.baseline);
    gpsContribution = Math.max(0, Math.min(OSINT_SIGNALS.gps.maxContribution, gpsContribution));
    const gpsDetail = data.gpsDetail || osint?.gps?.detail || 'Awaiting data...';
    const gpsDisplay = Math.min(100, Math.round((gpsContribution / OSINT_SIGNALS.gps.maxContribution) * 100));
    updateSignal('gps', gpsDisplay, gpsDetail);
    setStatus('gpsStatus', osintLive);
    if (osintLive && osint?.gps) {
        if (osint.gps.critical >= 2 || gpsContribution >= 6) setIocLevel('gps', 'high');
        else if (osint.gps.count >= 1 || gpsContribution >= 3) setIocLevel('gps', 'med');
        else setIocLevel('gps', null);
    } else {
        setIocLevel('gps', null);
    }

    let diplomatsContribution = toFiniteNumber(data.diplomats, osint?.diplomats?.contribution ?? OSINT_SIGNALS.diplomats.baseline);
    diplomatsContribution = Math.max(0, Math.min(OSINT_SIGNALS.diplomats.maxContribution, diplomatsContribution));
    const diplomatsDetail = data.diplomatsDetail || osint?.diplomats?.detail || 'Awaiting data...';
    const diplomatsDisplay = Math.min(100, Math.round((diplomatsContribution / OSINT_SIGNALS.diplomats.maxContribution) * 100));
    updateSignal('diplomats', diplomatsDisplay, diplomatsDetail);
    setStatus('diplomatsStatus', osintLive);
    if (osintLive && osint?.diplomats) {
        if (osint.diplomats.critical >= 1 || diplomatsContribution >= 9) setIocLevel('diplomats', 'high');
        else if (osint.diplomats.count >= 1 || diplomatsContribution >= 5) setIocLevel('diplomats', 'med');
        else setIocLevel('diplomats', null);
    } else {
        setIocLevel('diplomats', null);
    }

    if (!fromCache && osintLive) {
        if (osint.gps.critical >= 2) addFeed('OSINT', '🛰️ Multiple GPS/GNSS interference reports detected', true, 'Alert');
        if (osint.diplomats.critical >= 1) addFeed('OSINT', '🏛️ Diplomatic drawdown/evacuation language detected', true, 'Alert');
    }

    // MARKETS (Server-side)
    let marketsContribution = 0;
    if (data.markets && data.markets.data) {
        // Per-market scoring with special BTC weight (BTC trades 24/7)
        const usChange = toFiniteNumber(data.markets.data.US?.change_percent, 0);
        const ilChange = toFiniteNumber(data.markets.data.ISRAEL?.change_percent, 0);
        const btcChange = toFiniteNumber(data.markets.data.BITCOIN?.change_percent, 0);
        const ethChange = toFiniteNumber(data.markets.data.ETHEREUM?.change_percent, 0);

        const scoreFromChange = (change, thresholds) => {
            // change is % day-over-day (negative = risk)
            for (const [limit, score] of thresholds) {
                if (change <= limit) return score;
            }
            return 0;
        };

        const usScore = scoreFromChange(usChange, [[-2.0, 6], [-1.0, 4], [-0.5, 2]]);
        const ilScore = scoreFromChange(ilChange, [[-2.5, 6], [-1.2, 4], [-0.6, 2]]);
        // Special BTC weight: higher max, because it's live 24/7
        const btcScore = scoreFromChange(btcChange, [[-6.0, 8], [-3.0, 6], [-1.5, 4], [-0.7, 2]]);
        // ETH is also 24/7; slightly lower weight than BTC but still significant
        const ethScore = scoreFromChange(ethChange, [[-7.0, 7], [-4.0, 5], [-2.0, 3], [-1.0, 2]]);

        marketsContribution = Math.min(15, usScore + ilScore + btcScore + ethScore);
        const displayRisk = Math.min(100, Math.round((marketsContribution / 15) * 100));
        
        // Build detailed string showing all markets
        let detailStr = data.markets.summary || 'Monitoring';
        if (data.markets.data) {
            const states = [];
            if (data.markets.data.US) states.push(`US${data.markets.data.US.status === 'RED' ? '🔴' : '🟢'}`);
            if (data.markets.data.ISRAEL) states.push(`IL${data.markets.data.ISRAEL.status === 'RED' ? '🔴' : '🟢'}`);
            if (data.markets.data.BITCOIN) states.push(`BTC${data.markets.data.BITCOIN.status === 'RED' ? '🔴' : '🟢'}`);
            if (data.markets.data.ETHEREUM) states.push(`ETH${data.markets.data.ETHEREUM.status === 'RED' ? '🔴' : '🟢'}`);
            if (states.length > 0) detailStr = states.join(' ');
        }
        
        updateSignal('markets', displayRisk, detailStr);
        setStatus('marketsStatus', true);

        // Add feed item if significant
        if (!fromCache && (btcScore >= 6 || ethScore >= 5)) {
            const parts = [];
            if (btcScore >= 6) parts.push(`BTC ${btcChange.toFixed(2)}%`);
            if (ethScore >= 5) parts.push(`ETH ${ethChange.toFixed(2)}%`);
            addFeed('MARKETS', `Crypto risk-off ${parts.join(', ')} (24/7 sentiment)`, true, 'Alert');
        }
        else if (!fromCache && (usScore + ilScore) >= 8) addFeed('MARKETS', `Equity risk-off: US ${usChange.toFixed(2)}%, IL ${ilChange.toFixed(2)}%`, true, 'Alert');
    } else {
        updateSignal('markets', 10, 'Waiting for data...');
    }

    // Polymarket odds signal (from cached data updated by GitHub Actions)
    let polymarketOdds = 0;
    let polymarketContribution = 1; // baseline
    if (data.polymarket && data.polymarket.odds !== undefined) {
        // Safety: odds should be 0-100, cap at 100
        polymarketOdds = Math.min(100, Math.max(0, toFiniteNumber(data.polymarket.odds, 0)));

        polymarketContribution = Math.min(10, polymarketOdds * 0.1);
        const marketTitle = data.polymarket.market || 'Iran strike';

        updateSignal('polymarket', polymarketOdds, `${polymarketOdds}% odds`);
        setStatus('polymarketStatus', true);

        if (!fromCache && polymarketOdds >= 0) {
            const url = safeExternalUrl(data?.polymarket?.url) || safeExternalUrl(data?.polymarket?.market_url);
            const isAlert = polymarketOdds > 30;
            addFeed('MARKET', `📊 Polymarket: ${polymarketOdds}% odds on "${marketTitle.substring(0, 48)}"`, isAlert, isAlert ? 'Alert' : null, null, url);
        }
    } else {
        // No cached polymarket data yet - show baseline
        updateSignal('polymarket', 10, 'Awaiting data...');
        setStatus('polymarketStatus', true);
    }
    // Store for total calculation
    const safePolymarketCalc = polymarketContribution;
    setIocFromScore('polymarket', polymarketOdds, 30, 55);

    // AIRSPACE (Server-side)
    let airspaceContribution = 0;
    if (data.airspace && data.airspace.details) {
        const score = toFiniteNumber(data.airspace.score, 0); // raw 0..50 severity
        airspaceContribution = Math.min(15, Math.max(0, score * 0.3)); // 50 -> 15%

        const displayRisk = Math.min(100, Math.round(score * 2));
        const status = data.airspace.status || 'Normal';

        const details = Array.isArray(data.airspace.details) ? data.airspace.details : [];
        const normalized = details.map(d => String(d || '')
            .replace(/^CRITICAL:\s*/i, '')
            .replace(/^WARNING:\s*/i, '')
            .replace(/^NOTICE:\s*/i, '')
            .trim()).filter(Boolean);
        const where = normalized.length ? normalized.join(' • ') : status;
        updateSignal('airspace', displayRisk, where);
        setStatus('airspaceStatus', true);
        if (score >= 40) setIocLevel('airspace', 'high');
        else if (score >= 20) setIocLevel('airspace', 'med');
        else setIocLevel('airspace', null);

        if (!fromCache && score > 0) {
            const url = data?.airspace?.source_url || SOURCE_URLS.airspace;
            const firs = Array.isArray(data?.airspace?.fir_codes) ? data.airspace.fir_codes.join(', ') : 'OIIX, LLLL';
            const summary = `NOTAMs (${firs}): ${where}`;
            addFeed('AIRSPACE', summary, score >= 40, 'NOTAM', null, url);
        }
    } else {
        updateSignal('airspace', 5, 'Monitoring...');
        setIocLevel('airspace', null);
    }

    // Pentagon Pizza Meter signal (from cached data updated by GitHub Actions)
    // Max contribution: 10% of total risk
    // Display bar: Normal ~5-10%, Elevated ~30-50%, High ~70-100%
    let pentagonContribution = 0;
    if (data.pentagon && (data.pentagon.score !== undefined || data.pentagon.status)) {
        const rawScore = data.pentagon.score || 30; // 0-100 from script, default to low

        // Convert score to contribution (max 10%)
        // Low (score <40) = 1% contribution, shows ~10% on bar
        // Normal (score 40-60) = 2-3% contribution, shows ~20-30% on bar
        // Elevated (score 60-80) = 4-7% contribution, shows ~40-70% on bar
        // High (score 80+) = 8-10% contribution, shows ~80-100% on bar
        if (rawScore < 40) {
            pentagonContribution = 1; // Low activity baseline
        } else if (rawScore <= 60) {
            pentagonContribution = 1 + (rawScore - 40) * 0.1; // 1-3%
        } else if (rawScore <= 80) {
            pentagonContribution = 3 + (rawScore - 60) * 0.2; // 3-7%
        } else {
            pentagonContribution = 7 + (rawScore - 80) * 0.15; // 7-10%
        }
        pentagonContribution = Math.min(10, pentagonContribution);

        const pentagonStatus = data.pentagon.status || 'Normal';
        const isLateNight = data.pentagon.is_late_night || false;
        const isWeekend = data.pentagon.is_weekend || false;

        // Check if pentagon data is fresh (less than 40 minutes old)
        // Check pentagon.timestamp, pentagon_updated, or main data timestamp
        let pentagonTimestamp = 0;
        if (data.pentagon.timestamp) {
            pentagonTimestamp = new Date(data.pentagon.timestamp).getTime();
        } else if (data.pentagon_updated) {
            pentagonTimestamp = new Date(data.pentagon_updated).getTime();
        } else if (data.timestamp) {
            // Fall back to main cache timestamp
            pentagonTimestamp = data.timestamp;
        }
        const pentagonAge = Date.now() - pentagonTimestamp;
        // Show LIVE if: data < 40 min old OR we have valid pentagon status+score
        const isPentagonFresh = (pentagonTimestamp > 0 && pentagonAge < 40 * 60 * 1000) ||
            (data.pentagon.status && data.pentagon.score !== undefined);

        // Display bar: scale so Low (1%) shows as ~10%, High (10%) shows as 100%
        const displayRisk = Math.round((pentagonContribution / 10) * 100);
        const detail = `${pentagonStatus}${isLateNight ? ' (late night)' : ''}${isWeekend ? ' (weekend)' : ''}`;
        updateSignal('pentagon', displayRisk, detail);
        setStatus('pentagonStatus', isPentagonFresh);

        if (pentagonContribution >= 7) {
            addFeed('PENTAGON', `🍕 High activity detected near Pentagon`, true, 'Alert');
        }
    } else {
        // No pentagon data from GitHub Action - use time-based simulation
        // This keeps the signal LIVE while Action catches up
        const hour = new Date().getHours();
        const isLateNight = hour >= 22 || hour < 6;
        const isWeekend = [0, 6].includes(new Date().getDay());

        let simStatus = 'Normal';
        let simScore = 10;

        if (isLateNight) {
            simStatus = 'Low Activity';
            simScore = 8;
        } else if (isWeekend) {
            simStatus = 'Weekend';
            simScore = 8;
        } else if (hour >= 11 && hour <= 14) {
            simStatus = 'Lunch hour';
            simScore = 12;
        } else if (hour >= 17 && hour <= 20) {
            simStatus = 'Dinner hour';
            simScore = 12;
        }

        pentagonContribution = 1; // Baseline contribution
        updateSignal('pentagon', simScore, simStatus);
        setStatus('pentagonStatus', true); // Show LIVE with simulated data
    }

    // Restore feed items from cache
    if (fromCache && data.feedItems && data.feedItems.length > 0) {
        state.feedItems = data.feedItems;
        state.seenHeadlines = new Set(data.feedItems.map(i => i.text.substring(0, 50).toLowerCase()));
        renderFeed();
    }

    // Show last server-side (.py) update time if available
    updatePyLastUpdate(data);
    updateSourceLinks(data);

    // Base score (acts as "now" score) from signals
    let total = safeNews + safeInterest + safeAviation + maritimeContribution + safeMilitary + marketsContribution + safePolymarketCalc + airspaceContribution + pentagonContribution + safeWeather + gpsContribution + diplomatsContribution;

    const elevated = [safeNews > 10, safeInterest > 8, safeAviation > 10, maritimeContribution > 4, safeMilitary > 6, marketsContribution > 5, airspaceContribution > 5, pentagonContribution > 5, gpsContribution > 3, diplomatsContribution > 4].filter(Boolean).length;
    if (elevated >= 3) {
        total = Math.min(100, total * 1.15);
        if (!fromCache) addFeed('SYSTEM', 'Multiple elevated signals detected - escalation multiplier applied', true, 'Alert');
    }

    total = Math.min(100, Math.max(0, Math.round(total) || 0));

    // Projected risk (next 8 hours)
    const newsAlertCountForIoc = toFiniteNumber(data?.news_intel?.alert_count, 0);
    const airspaceScoreForIoc = toFiniteNumber(data?.airspace?.score, 0);
    const osintGpsCount = osintLive ? toFiniteNumber(osint?.gps?.count, 0) : 0;
    const osintGpsCritical = osintLive ? toFiniteNumber(osint?.gps?.critical, 0) : 0;
    const osintDipCount = osintLive ? toFiniteNumber(osint?.diplomats?.count, 0) : 0;
    const osintDipCritical = osintLive ? toFiniteNumber(osint?.diplomats?.critical, 0) : 0;

    let iocScore = 0;
    if (newsAlertCountForIoc >= 2) iocScore += 2;
    else if (newsAlertCountForIoc >= 1) iocScore += 1;

    if (polymarketOdds >= 55) iocScore += 2;
    else if (polymarketOdds >= 30) iocScore += 1;

    if (airspaceScoreForIoc >= 40) iocScore += 2;
    else if (airspaceScoreForIoc >= 20) iocScore += 1;

    if (safeAviation >= 12) iocScore += 2;
    else if (safeAviation >= 8) iocScore += 1;

    if (safeMilitary >= 10) iocScore += 2;
    else if (safeMilitary >= 6) iocScore += 1;

    if (gpsContribution >= 6 || osintGpsCritical >= 2) iocScore += 2;
    else if (gpsContribution >= 3 || osintGpsCount >= 1) iocScore += 1;

    if (diplomatsContribution >= 9 || osintDipCritical >= 1) iocScore += 2;
    else if (diplomatsContribution >= 5 || osintDipCount >= 1) iocScore += 1;

    if (maritimeContribution >= 9 || maritimeCritical >= 1) iocScore += 2;
    else if (maritimeContribution >= 5 || maritimeCount >= 1) iocScore += 1;

    let projectedTotal = projectRiskNext8Hours(total, data?.history || [], iocScore);
    const serverProjected = toFiniteNumber(data?.risk_projected_8h, NaN);
    if (Number.isFinite(serverProjected)) projectedTotal = Math.round(Math.max(0, Math.min(100, serverProjected)));

    const prevRisk = state.risk;
    updateGauge(projectedTotal);

    // Emit per-signal score deltas into the Intelligence Feed (with source links when possible)
    if (!fromCache && state.lastSignalSnapshot && state.lastSignalSnapshot.contributions) {
        const prevC = state.lastSignalSnapshot.contributions;
        const currC = {
            news: safeNews,
            interest: safeInterest,
            aviation: safeAviation,
            maritime: maritimeContribution,
            military: safeMilitary,
            markets: marketsContribution,
            polymarket: safePolymarketCalc,
            airspace: airspaceContribution,
            pentagon: pentagonContribution,
            weather: safeWeather,
            gps: gpsContribution,
            diplomats: diplomatsContribution
        };

        const labels = {
            news: 'News Intel',
            interest: 'Public Interest',
            aviation: 'Civil Aviation',
            maritime: 'Maritime NtM (Hormuz)',
            military: 'Military Trackers',
            markets: 'Stock Markets',
            polymarket: 'Market Odds',
            airspace: 'Airspace NOTAMs',
            pentagon: 'Pentagon Pizza Meter',
            weather: 'Op. Conditions',
            gps: 'GPS/GNSS Interference',
            diplomats: 'Diplomatic Posture'
        };

        const firstArticle = getFirstArticleUrl(data?.news_intel?.articles);
        const polymarketUrl = safeExternalUrl(data?.polymarket?.url) || safeExternalUrl(data?.polymarket?.market_url) || SOURCE_URLS.polymarket;
        const urls = {
            news: firstArticle || 'https://www.bbc.com/news',
            interest: SOURCE_URLS.trends,
            aviation: SOURCE_URLS.aviation,
            maritime: firstArticle || SOURCE_URLS.maritime,
            military: SOURCE_URLS.military,
            markets: SOURCE_URLS.markets,
            polymarket: polymarketUrl,
            airspace: SOURCE_URLS.airspace,
            pentagon: SOURCE_URLS.pentagon,
            weather: SOURCE_URLS.weather,
            gps: firstArticle || SOURCE_URLS.trends,
            diplomats: firstArticle || 'https://www.state.gov/'
        };

        const details = {
            news: document.getElementById('newsDetail')?.textContent || '',
            interest: document.getElementById('socialDetail')?.textContent || '',
            aviation: document.getElementById('flightDetail')?.textContent || '',
            maritime: document.getElementById('maritimeDetail')?.textContent || '',
            military: document.getElementById('militaryDetail')?.textContent || '',
            markets: document.getElementById('marketsDetail')?.textContent || '',
            polymarket: document.getElementById('polymarketDetail')?.textContent || '',
            airspace: document.getElementById('airspaceDetail')?.textContent || '',
            pentagon: document.getElementById('pentagonDetail')?.textContent || '',
            weather: document.getElementById('weatherDetail')?.textContent || '',
            gps: document.getElementById('gpsDetail')?.textContent || '',
            diplomats: document.getElementById('diplomatsDetail')?.textContent || ''
        };

        const changes = Object.entries(currC)
            .map(([k, v]) => {
                const dv = toFiniteNumber(v, 0) - toFiniteNumber(prevC[k], 0);
                return { k, dv, v: toFiniteNumber(v, 0) };
            })
            .filter(x => Math.abs(x.dv) >= 1.5)
            .sort((a, b) => Math.abs(b.dv) - Math.abs(a.dv))
            .slice(0, 6);

        for (const c of changes) {
            const sign = c.dv > 0 ? '+' : '-';
            const deltaPts = Math.round(Math.abs(c.dv));
            const badge = `Score ${sign}${deltaPts}`;
            const tone = c.dv < 0 ? 'positive' : null;
            const isAlert = c.dv >= 3;
            const detail = details[c.k] ? ` (${details[c.k]})` : '';
            addFeed('SCORE', `${labels[c.k]} ${sign}${deltaPts}${detail}`, isAlert, badge, tone, urls[c.k]);
        }
    }

    // Explain de-escalation in the Intelligence Feed (green) with country context when possible
    const nowTs = Date.now();
    const delta = projectedTotal - prevRisk;
    if (prevRisk > 0 && delta <= -5 && (nowTs - state.lastDeescalationAt) > 10 * 60 * 1000) {
        const prev = state.lastSignalSnapshot;
        const curr = {
            contributions: {
                news: safeNews,
                interest: safeInterest,
                aviation: safeAviation,
                maritime: maritimeContribution,
                military: safeMilitary,
                markets: marketsContribution,
                polymarket: safePolymarketCalc,
                airspace: airspaceContribution,
                pentagon: pentagonContribution,
                weather: safeWeather,
                gps: gpsContribution,
                diplomats: diplomatsContribution
            },
            marketsStates: {
                US: data?.markets?.data?.US?.status || null,
                ISRAEL: data?.markets?.data?.ISRAEL?.status || null,
                BITCOIN: data?.markets?.data?.BITCOIN?.status || null,
                ETHEREUM: data?.markets?.data?.ETHEREUM?.status || null
            },
            marketsChange: {
                US: toFiniteNumber(data?.markets?.data?.US?.change_percent, NaN),
                ISRAEL: toFiniteNumber(data?.markets?.data?.ISRAEL?.change_percent, NaN),
                BITCOIN: toFiniteNumber(data?.markets?.data?.BITCOIN?.change_percent, NaN),
                ETHEREUM: toFiniteNumber(data?.markets?.data?.ETHEREUM?.change_percent, NaN)
            },
            flightDetail,
            militaryDetail,
            newsAlertCount: toFiniteNumber(data?.news_intel?.alert_count, 0),
        };

        const reasons = [];
        if (prev && prev.contributions) {
            const d = Object.entries(curr.contributions)
                .map(([k, v]) => ({ k, dv: toFiniteNumber(v, 0) - toFiniteNumber(prev.contributions[k], 0) }))
                .filter(x => x.dv < -0.9)
                .sort((a, b) => a.dv - b.dv)
                .slice(0, 3);
            for (const x of d) {
                if (x.k === 'markets') {
                    const parts = [];
                    const us = curr.marketsStates.US ? `US ${curr.marketsStates.US}` : null;
                    const il = curr.marketsStates.ISRAEL ? `IL ${curr.marketsStates.ISRAEL}` : null;
                    const btc = curr.marketsStates.BITCOIN ? `BTC ${curr.marketsStates.BITCOIN}` : null;
                    const eth = curr.marketsStates.ETHEREUM ? `ETH ${curr.marketsStates.ETHEREUM}` : null;
                    if (us) parts.push(us);
                    if (il) parts.push(il);
                    if (btc) parts.push(btc);
                    if (eth) parts.push(eth);
                    const liveCrypto = [
                        Number.isFinite(curr.marketsChange.BITCOIN) ? `BTC ${curr.marketsChange.BITCOIN.toFixed(2)}%` : null,
                        Number.isFinite(curr.marketsChange.ETHEREUM) ? `ETH ${curr.marketsChange.ETHEREUM.toFixed(2)}%` : null
                    ].filter(Boolean);
                    const extra = liveCrypto.length ? `, ${liveCrypto.join(', ')}` : '';
                    reasons.push(`Markets easing (${parts.join(', ')}${extra})`);
                } else if (x.k === 'aviation') {
                    reasons.push(`Aviation normalizing (${flightDetail})`);
                } else if (x.k === 'military') {
                    reasons.push(`Military activity down (${militaryDetail})`);
                } else if (x.k === 'news') {
                    reasons.push(`News pressure lower (${curr.newsAlertCount} critical)`);
                } else if (x.k === 'maritime') {
                    reasons.push('Maritime advisories eased');
                } else if (x.k === 'airspace') {
                    reasons.push('Airspace restrictions easing');
                } else if (x.k === 'gps') {
                    reasons.push('Less GPS/GNSS interference chatter');
                } else if (x.k === 'diplomats') {
                    reasons.push('Fewer diplomatic drawdown signals');
                } else if (x.k === 'polymarket') {
                    reasons.push('Market odds lower');
                } else if (x.k === 'interest') {
                    reasons.push('Public interest cooling');
                } else if (x.k === 'weather') {
                    reasons.push('Conditions less favorable');
                } else if (x.k === 'pentagon') {
                    reasons.push('Lower Pentagon activity');
                }
            }
        }

        const reasonText = reasons.length ? reasons.join(' • ') : 'Signals eased across multiple indicators';
        addFeed('SYSTEM', `Risk down ${Math.abs(delta)}%: ${reasonText}`, false, 'De-escalation', 'positive');
        state.lastDeescalationAt = nowTs;
        state.lastSignalSnapshot = curr;
    } else {
        state.lastSignalSnapshot = {
            contributions: {
                news: safeNews,
                interest: safeInterest,
                aviation: safeAviation,
                maritime: maritimeContribution,
                military: safeMilitary,
                markets: marketsContribution,
                polymarket: safePolymarketCalc,
                airspace: airspaceContribution,
                pentagon: pentagonContribution,
                weather: safeWeather,
                gps: gpsContribution,
                diplomats: diplomatsContribution
            }
        };
    }

    // Update timestamp with the actual data timestamp
    updateTimestamp(data?.strikeraedar_updated_ms || data?.timestamp);

    // Send Telegram alert if risk crossed 60% threshold
    if (!fromCache && ALLOW_TELEGRAM_ALERTS) {
        sendTelegramAlert(projectedTotal, prevRisk);
    }

    if (projectedTotal > maxRiskSeen) maxRiskSeen = projectedTotal;

    trackEvent('risk_update', 'metrics', getStatusText(projectedTotal), projectedTotal);
    safeGtagEvent('signal_update', {
        news_score: Math.round(safeNews),
        interest_score: Math.round(safeInterest),
        aviation_score: Math.round(safeAviation),
        maritime_score: Math.round(maritimeContribution),
        military_score: Math.round(safeMilitary),
        markets_score: Math.round(marketsContribution),
        airspace_score: Math.round(airspaceContribution),
        gps_score: Math.round(gpsContribution),
        diplomats_score: Math.round(diplomatsContribution),
        total_risk: projectedTotal,
        ioc_score: iocScore
    });

    if (Math.abs(projectedTotal - prevRisk) > 10) {
        trackEvent('risk_change', 'alert', projectedTotal > prevRisk ? 'risk_increased' : 'risk_decreased', Math.abs(projectedTotal - prevRisk));
    }
    if (projectedTotal >= 60 && prevRisk < 60) {
        trackEvent('high_risk_alert', 'alert', 'crossed_60_threshold', projectedTotal);
    }
    if (projectedTotal >= 85 && prevRisk < 85) {
        trackEvent('imminent_risk_alert', 'alert', 'crossed_85_threshold', projectedTotal);
    }

    // Chart is now updated from history data, not here
    return projectedTotal;
}

// TELEGRAM ALERT - sends notification when risk crosses 60%
let lastAlertSent = 0;
const ALERT_COOLDOWN = 60 * 60 * 1000; // 1 hour between alerts

async function sendTelegramAlert(risk, prevRisk) {
    // Only send if crossing UP through 60% threshold
    if (risk < 60 || prevRisk >= 60) return;

    // Check cooldown
    const now = Date.now();
    if (now - lastAlertSent < ALERT_COOLDOWN) {
        console.log('Alert cooldown active, skipping Telegram notification');
        return;
    }

    const statusEmoji = risk >= 86 ? '🔴' : risk >= 61 ? '🟠' : '🟡';
    const message = `${statusEmoji} *BetterLife Alert*

📊 Projected Risk (8h): *${risk}%* (${getStatusText(risk)})
⏱️ Window: Next 8 Hours

📰 News: ${document.getElementById('newsValue').textContent}
📈 Interest: ${document.getElementById('socialValue').textContent}
✈️ Aviation: ${document.getElementById('flightValue').textContent}
🎯 Military: ${document.getElementById('militaryValue')?.textContent || '--'}
🛰️ GPS/GNSS: ${document.getElementById('gpsValue')?.textContent || '--'}
🏛️ Diplomats: ${document.getElementById('diplomatsValue')?.textContent || '--'}
📉 Markets: ${document.getElementById('marketsValue').textContent}
🚫 Airspace: ${document.getElementById('airspaceValue').textContent}

🔗 [View Dashboard](https://{PLACEHOLDER}.github.io/{placeholder})`;

    try {
        const res = await fetch(`https://api.telegram.org/bot${API_KEYS.telegram}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHANNEL,
                text: message,
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            })
        });

        if (res.ok) {
            lastAlertSent = now;
            console.log('Telegram alert sent successfully');
            addFeed('TELEGRAM', 'Alert sent to subscribers', false);
        } else {
            const err = await res.json();
            console.log('Telegram error:', err.description);
        }
    } catch (e) {
        console.log('Telegram send error:', e.message);
    }
}

// Track last API call time to prevent excessive calls
let lastAPICall = 0;
const MIN_API_INTERVAL = 15 * 60 * 1000; // Minimum 15 minutes between API calls

// MASTER CALCULATION - checks cache first, only calls APIs if cache is old
async function calculate() {
    // Read-only mode: always render from the shared cache for consistent values across users.
    let cached = await getCache();
    let usedLocalFallback = false;

    if (!cached) {
        try {
            const local = localStorage.getItem('betterlife_cache');
            if (local) cached = JSON.parse(local);
        } catch (e) { }
        usedLocalFallback = !!cached;
    }

    if (cached) {
        state.usingLocalCache = usedLocalFallback;
        state.cacheSeedMs = toFiniteNumber(cached?.strikeraedar_updated_ms, toFiniteNumber(cached?.timestamp, Date.now()));
        const cacheMs = toFiniteNumber(cached?.strikeraedar_updated_ms, toFiniteNumber(cached?.timestamp, 0));
        const isNewData = cacheMs && cacheMs !== state.lastCacheSeenMs;
        if (cacheMs) state.lastCacheSeenMs = cacheMs;

        updatePyLastUpdate(cached);
        if (cached) updateSourceLinks(cached);
        updateOnlineStatus();

        const total = displayData(cached, !isNewData || usedLocalFallback);
        updateChartFromHistory(cached.history);
        try {
            localStorage.setItem('betterlife_cache', JSON.stringify(cached));
        } catch (e) { }
        return total;
    }

    // No cache at all
    updateSignal('news', 10, 'Awaiting data...');
    updateSignal('social', 8, 'Awaiting data...');
    updateSignal('flight', 12, 'Awaiting data...');
    updateSignal('maritime', 0, 'Awaiting data...');
    updateSignal('military', 10, 'Awaiting data...');
    updateSignal('weather', 'Marginal', 'Awaiting data...');
    updateSignal('polymarket', 0, '0% odds');
    updateSignal('pentagon', 10, 'Awaiting data...');
    updateSignal('gps', 5, 'Awaiting data...');
    updateSignal('diplomats', 5, 'Awaiting data...');
    updateSignal('markets', 10, 'Awaiting data...');
    updateSignal('airspace', 5, 'Awaiting data...');
    updateGauge(15);
}

// Update chart with real history data (fills gaps with simulated data)
function updateChartFromHistory(history) {
    if (!chart) return;

    state.trendLabels = [];
    state.trendData = [];

    const now = Date.now();
    const interval = 12 * 60 * 60 * 1000; // 12 hours
    const points = 7; // 7 points for 72 hours

    // Build time slots for the chart (every 12 hours going back 72h)
    const slots = [];
    for (let i = points - 1; i >= 0; i--) {
        slots.push(now - i * interval);
    }

    // Create a map of real history data by rounded timestamp
    const historyMap = new Map();
    if (history && history.length > 0) {
        history.forEach(h => {
            // Find closest slot for this history point
            let closestSlot = slots[0];
            let minDiff = Math.abs(h.timestamp - slots[0]);
            slots.forEach(slot => {
                const diff = Math.abs(h.timestamp - slot);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestSlot = slot;
                }
            });
            // Only use if within 6 hours of slot
            if (minDiff < 6 * 60 * 60 * 1000) {
                historyMap.set(closestSlot, h.risk);
            }
        });
    }

    // Build chart data - use real data where available, simulated where not
    let lastDate = '';
    const seed = Math.floor(now / 86400000); // Stable seed per day

    slots.forEach((slot, i) => {
        const d = new Date(slot);
        const dateStr = formatDate(d);
        const hourStr = d.getHours().toString().padStart(2, '0') + ':00';

        // Label
        let label;
        if (i === slots.length - 1) {
            label = 'Now';
        } else if (dateStr !== lastDate) {
            label = dateStr;
            lastDate = dateStr;
        } else {
            label = hourStr;
        }
        state.trendLabels.push(label);

        // Data - real or simulated
        if (historyMap.has(slot)) {
            state.trendData.push(historyMap.get(slot));
        } else {
            // Simulated data based on seed + position
            const pseudoRandom = Math.abs(Math.sin(seed + i * 7) * 43758.5453) % 1;
            state.trendData.push(Math.round(pseudoRandom * 20 + 10)); // 10-30% range
        }
    });

    // Update chart
    chart.data.labels = state.trendLabels;
    chart.data.datasets[0].data = state.trendData;
    chart.update('none');
}

document.addEventListener('DOMContentLoaded', async () => {
    attachSourceMenuHandlers();
    // Load history first for chart
    const cached = await getCache();
    initChart(cached?.history);
    addFeed('SYSTEM', 'BetterLife initialized');
    updatePyLastUpdate(cached);
    if (cached) updateSourceLinks(cached);

    // Track page load event
    safeGtagEvent('page_load', {
        page_title: 'BetterLife Dashboard',
        page_location: window.location.href,
        user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });

    // Refresh from shared cache every minute (best-effort "no-cache" and consistent updates across devices).
    setTimeout(() => { calculate(); setInterval(calculate, 60000); }, 500);
});

// Track visibility changes (user comes back to tab)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        trackEvent('tab_return', 'engagement', 'user_returned');
    }
});

// Secret force refresh: Press R 3 times quickly
let rPresses = [];
document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'r') {
        const now = Date.now();
        rPresses.push(now);
        // Keep only presses within last 1 second
        rPresses = rPresses.filter(t => now - t < 1000);
        if (rPresses.length >= 3) {
            rPresses = [];
            console.log('Force refresh triggered!');
            forceRefresh();
        }
    }
});

async function forceRefresh() {
    showToast('🔄 Refreshing from cache...');
    await calculate();
    showToast('✅ Updated');
}

function showToast(message) {
    // Remove existing toast if any
    const existing = document.getElementById('toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'toast';
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#22c55e;color:#000;padding:14px 28px;border-radius:12px;font-size:15px;font-weight:600;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.5);';
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// Offline/online detection
function updateOnlineStatus() {
    const offlineBar = document.getElementById('offlineBar');
    if (!offlineBar) return;
    if (state.usingLocalCache) {
        offlineBar.style.display = 'block';
        offlineBar.textContent = '⚠️ Using local cached data (shared cache fetch failed)';
        document.body.style.paddingBottom = '40px';
        return;
    }
    offlineBar.textContent = "⚠️ You're offline - showing last available data";
    if (!navigator.onLine) {
        offlineBar.style.display = 'block';
        document.body.style.paddingBottom = '40px';
    } else {
        offlineBar.style.display = 'none';
        document.body.style.paddingBottom = '0';
    }
}
// Theme Management
function toggleTheme() {
    const html = document.documentElement;
    const isDark = !html.classList.contains('light-mode');

    if (isDark) {
        html.classList.add('light-mode');
        localStorage.setItem('theme', 'light');
        document.getElementById('themeIcon').innerHTML = '🌙';
    } else {
        html.classList.remove('light-mode');
        localStorage.setItem('theme', 'dark');
        document.getElementById('themeIcon').innerHTML = '☀️';
    }
}

// Initialize Theme
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const themeIcon = document.getElementById('themeIcon');

    if (savedTheme === 'light' || (!savedTheme && !prefersDark)) {
        document.documentElement.classList.add('light-mode');
        if (themeIcon) themeIcon.innerHTML = '🌙';
    } else {
        document.documentElement.classList.remove('light-mode');
        if (themeIcon) themeIcon.innerHTML = '☀️';
    }
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();
initTheme();
