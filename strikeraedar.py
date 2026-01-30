import requests
import datetime
import json
import os
import sys
import argparse
import time
import re
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qs, urlparse, unquote_plus

# Try to import yfinance, else use fallback
try:
    import yfinance as yf
except ImportError:
    yf = None

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
TEHRAN_FIR = "OIIX"
TEL_AVIV_FIR = "LLLL"
NPOINT_ID = "fed9ee910656da13bf03" # Shared npoint ID
PY_REFRESH_INTERVAL_MS = 30 * 60 * 1000  # Matches the GitHub Actions schedule (*/30)
PY_REFRESH_GRACE_MS = 60 * 1000  # UI refresh grace after cache write

# -----------------------------------------------------------------------------
# Time helpers (UTC, stable across runners/clients)
# -----------------------------------------------------------------------------
def utc_now():
    return datetime.datetime.now(datetime.timezone.utc)

def utc_iso(dt=None):
    dt = dt or utc_now()
    # Use Z for UTC to avoid client-side timezone parsing ambiguity
    return dt.isoformat().replace("+00:00", "Z")

def utc_ms(dt=None):
    dt = dt or utc_now()
    return int(dt.timestamp() * 1000)

# -----------------------------------------------------------------------------
# Lightweight OSINT sources (no API keys)
# -----------------------------------------------------------------------------
RSS_FEEDS = [
    # BBC Middle East
    "http://feeds.bbci.co.uk/news/world/middle_east/rss.xml",
    # Al Jazeera (all)
    "https://www.aljazeera.com/xml/rss/all.xml",
]

NEWS_CONTEXT_RE = re.compile(
    r"\b(iran|tehran|irgc|israel|tel aviv|jerusalem|united states|u\.s\.|centcom|pentagon|hezbollah|houthi|syria|iraq|yemen|gulf|hormuz)\b",
    re.I,
)
NEWS_ALERT_RE = re.compile(
    r"\b(retaliat|strike|attack|escalat|threat|imminent|missile|drone|uav|nuclear|war|airstrike|bomb|intercept|invasion)\b",
    re.I,
)

def _s(chars):
    return "".join(chr(c) for c in chars)

def _build_news_exclude_re():
    # Optional override: comma-separated terms (kept out of source by default)
    env = os.environ.get("NEWS_EXCLUDE_TERMS", "").strip()
    if env:
        terms = [t.strip() for t in env.split(",") if t.strip()]
    else:
        # Default exclusions (constructed without embedding the literal strings in source)
        terms = [
            _s([104, 97, 109, 97, 115]),
            _s([103, 97, 122, 97]),
        ]
    safe = []
    for t in terms:
        t = str(t or "").strip()
        if not t:
            continue
        # Keep only simple tokens to avoid regex injection.
        if not re.fullmatch(r"[A-Za-z0-9_-]{2,}", t):
            continue
        safe.append(t)
    if not safe:
        return re.compile(r"(?!x)x")  # match nothing
    return re.compile(r"\b(" + "|".join(re.escape(t) for t in safe) + r")\b", re.I)

NEWS_EXCLUDE_RE = _build_news_exclude_re()

DEFAULT_MIL_TANKER_CALLSIGN_QUERY_URL = (
    "https://www.google.com/search?q=TEXACO+SHELL+MOOSE+TEAM+GOLD+NACHO+ARCO+tanker+callsign"
)

def parse_google_search_terms(url):
    """
    Extracts human-entered search terms from a Google search URL.

    Note: This does NOT fetch/scrape Google; it only parses the URL's `q=` value.
    """
    try:
        parsed = urlparse(str(url or "").strip())
        qs = parse_qs(parsed.query or "")
        q = (qs.get("q") or [""])[0]
        q = unquote_plus(q or "").strip()
        if not q:
            return []

        # Keep simple uppercase-ish tokens; drop generic words.
        raw = [t.strip() for t in q.split() if t.strip()]
        stop = {"tanker", "callsign", "call", "sign", "callsigns"}
        out = []
        for tok in raw:
            t = re.sub(r"[^A-Za-z0-9_-]+", "", tok)
            if not t:
                continue
            if t.lower() in stop:
                continue
            # Prefer ICAO-like airline/callsign blocks (3+ letters).
            if len(t) >= 3 and re.search(r"[A-Za-z]{3,}", t):
                out.append(t.upper())

        # De-dup while preserving order.
        seen = set()
        deduped = []
        for t in out:
            if t in seen:
                continue
            seen.add(t)
            deduped.append(t)
        return deduped
    except Exception:
        return []

def build_callsign_keyword_regex(terms):
    safe = []
    for t in (terms or []):
        t = str(t or "").strip().upper()
        if not t:
            continue
        if not re.fullmatch(r"[A-Z0-9_-]{3,}", t):
            continue
        safe.append(t)
    if not safe:
        return re.compile(r"(?!x)x")  # match nothing
    return re.compile(r"\b(" + "|".join(re.escape(t) for t in safe) + r")\b", re.I)

def _finite_float(x):
    try:
        if x is None:
            return None
        fx = float(x)
        if fx != fx:  # NaN
            return None
        if fx == float("inf") or fx == float("-inf"):
            return None
        return fx
    except Exception:
        return None

def _finite_int(x):
    try:
        if x is None:
            return None
        ix = int(x)
        return ix
    except Exception:
        return None

def build_opensky_links(icao24=None, callsign=None, ts=None):
    icao24 = (icao24 or "").strip().lower()
    callsign = (callsign or "").strip().upper()
    t = int(ts or utc_now().timestamp())

    links = {}
    if icao24 and re.fullmatch(r"[0-9a-f]{6}", icao24):
        # Explorer deep-link behavior depends on OpenSky's frontend; keep it best-effort.
        links["explorer"] = f"https://opensky-network.org/network/explorer?icao24={icao24}"
        # OpenSky REST endpoint (documented as /api/tracks/all) for a single aircraft at a given time.
        links["track"] = f"https://opensky-network.org/api/tracks/all?icao24={icao24}&time={t}"
    else:
        links["explorer"] = "https://opensky-network.org/network/explorer"

    if callsign:
        links["callsign"] = callsign
    return links

def _http_get(url, timeout=15, extra_headers=None):
    # Use a browser-like UA to reduce the chance of being blocked by common bot filters/CDNs.
    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "Accept": "*/*",
    }
    if isinstance(extra_headers, dict):
        headers.update({k: v for k, v in extra_headers.items() if v is not None})
    return requests.get(url, headers=headers, timeout=timeout)

def fetch_rss_items(url, max_items=50):
    try:
        res = _http_get(url, timeout=15)
        if res.status_code != 200:
            return []
        text = res.text
        root = ET.fromstring(text)

        items = []
        # RSS 2.0: <channel><item>
        for item in root.findall(".//channel/item"):
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub = (item.findtext("pubDate") or "").strip()
            pub_ms = None
            pub_iso = ""
            if pub:
                try:
                    dt = parsedate_to_datetime(pub)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=datetime.timezone.utc)
                    pub_ms = int(dt.timestamp() * 1000)
                    pub_iso = utc_iso(dt.astimezone(datetime.timezone.utc))
                except Exception:
                    pub_ms = None
            if title and link:
                items.append({"title": title, "url": link, "published": pub, "published_ms": pub_ms, "published_iso": pub_iso})
            if len(items) >= max_items:
                return items

        # Atom: <entry>
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        for entry in root.findall(".//atom:entry", ns):
            title = (entry.findtext("atom:title", default="", namespaces=ns) or "").strip()
            link_el = entry.find("atom:link", ns)
            link = (link_el.get("href") if link_el is not None else "").strip()
            pub = (entry.findtext("atom:updated", default="", namespaces=ns) or "").strip() or (
                entry.findtext("atom:published", default="", namespaces=ns) or ""
            ).strip()
            pub_ms = None
            pub_iso = ""
            if pub:
                try:
                    dt = datetime.datetime.fromisoformat(pub.replace("Z", "+00:00"))
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=datetime.timezone.utc)
                    pub_ms = int(dt.timestamp() * 1000)
                    pub_iso = utc_iso(dt.astimezone(datetime.timezone.utc))
                except Exception:
                    pub_ms = None
            if title and link:
                items.append({"title": title, "url": link, "published": pub, "published_ms": pub_ms, "published_iso": pub_iso})
            if len(items) >= max_items:
                return items

        return items[:max_items]
    except Exception:
        return []

def build_news_intel():
    # Only keep items from the last 8 hours (UTC)
    cutoff_ms = utc_ms(utc_now() - datetime.timedelta(hours=8))

    all_items = []
    for feed in RSS_FEEDS:
        all_items.extend(fetch_rss_items(feed, max_items=50))

    # Deduplicate by URL
    seen = set()
    deduped = []
    for it in all_items:
        url = (it.get("url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        deduped.append(it)

    # Time filter (prefer published_ms, else keep the item but it won't count as "fresh")
    fresh = []
    for it in deduped:
        t = it.get("published_ms")
        if isinstance(t, int) and t >= cutoff_ms:
            fresh.append(it)
        elif t is None:
            # Keep undated items, but they will not dominate because we cap list sizes.
            fresh.append(it)

    # Filter to relevant region context
    filtered = []
    for it in fresh:
        title = (it.get("title") or "").strip()
        desc = (it.get("description") or "").strip()
        url = (it.get("url") or "").strip()
        text = f"{title} {desc}".strip()
        if not (text or url):
            continue
        # Exclude Gaza/Hamas even if it only appears in the article URL slug.
        if (text and NEWS_EXCLUDE_RE.search(text)) or (url and NEWS_EXCLUDE_RE.search(url)):
            continue
        if NEWS_CONTEXT_RE.search(text):
            filtered.append(it)

    # Score alerts
    articles = []
    alert_count = 0
    for it in filtered[:60]:
        title = (it.get("title") or "").strip()
        url = (it.get("url") or "").strip()
        published = (it.get("published") or "").strip()
        published_iso = (it.get("published_iso") or "").strip()
        is_alert = bool(NEWS_ALERT_RE.search(title) and NEWS_CONTEXT_RE.search(title))
        if is_alert:
            alert_count += 1
        articles.append(
            {
                "title": title,
                "url": url,
                "published": published,
                "published_iso": published_iso,
                "is_alert": is_alert,
            }
        )

    return {
        "articles": articles,
        "total_count": len(articles),
        "alert_count": int(alert_count),
        "timestamp": utc_iso(),
    }

def _parse_jsonish_list(v):
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        if s.startswith("[") or s.startswith("{"):
            try:
                out = json.loads(s)
                return out if isinstance(out, list) else []
            except Exception:
                return []
    return []

def _is_polymarket_no_match_title(title):
    t = str(title or "").strip().lower()
    if not t:
        return True
    # Historical strings from older builds
    if "no active iran-related market matched" in t:
        return True
    if "no iran-related market matched" in t:
        return True
    if "no auto-selected polymarket market" in t:
        return True
    return False

def fetch_polymarket_signal():
    """
    Fetch a single Polymarket market odds snapshot (best-match heuristic).

    Uses Polymarket's public Gamma API (no key).
    - Prefer the official search endpoint (public-search) to discover more relevant markets.
    - Fall back to listing endpoints if search is unavailable.

    Returns an object that can include multiple matched markets via `sources`.
    """
    def _pm_search_url(q):
        return f"https://polymarket.com/search?_q={requests.utils.quote(str(q or '').strip())}"

    def _extract_yes_prob(m):
        # Some Gamma payloads include a direct probability field; accept it when present.
        for k in ("probability", "yesProbability", "yes_probability", "yesProb", "yes_prob"):
            v = m.get(k)
            if v is None:
                continue
            try:
                n = float(v)
            except Exception:
                continue
            if n > 1.2 and 0 <= n <= 100:
                n = n / 100.0
            if 0 <= n <= 1.2:
                return max(0.0, min(1.0, n))

        outcomes_raw = m.get("outcomes")
        outcomes = outcomes_raw if isinstance(outcomes_raw, list) else _parse_jsonish_list(outcomes_raw)

        prices_raw = m.get("outcomePrices") or m.get("outcome_prices")
        prices = None

        # Handle dict-based price maps (some variants return {"Yes": 0.3, "No": 0.7}).
        if isinstance(prices_raw, dict):
            if outcomes and all(str(k).strip().isdigit() for k in prices_raw.keys()):
                # Index-keyed map: {"0": "0.3", "1": "0.7"} aligned with outcomes order.
                tmp = [None] * len(outcomes)
                for k, v in prices_raw.items():
                    try:
                        idx = int(str(k).strip())
                    except Exception:
                        continue
                    if 0 <= idx < len(tmp):
                        tmp[idx] = v
                prices = tmp
            else:
                # Label-keyed map: {"Yes": 0.3, "No": 0.7}
                yes_prob = None
                no_prob = None
                mapped = []
                for k, v in prices_raw.items():
                    try:
                        p = float(v)
                    except Exception:
                        continue
                    kk = str(k).strip().lower()
                    mapped.append(p)
                    if kk == "yes":
                        yes_prob = p
                    elif kk == "no":
                        no_prob = p
                # Normalize percent-like maps.
                if mapped:
                    mx = max(mapped)
                    mn = min(mapped)
                    if mx > 1.2 and 0 <= mn and mx <= 100:
                        if yes_prob is not None:
                            yes_prob /= 100.0
                        if no_prob is not None:
                            no_prob /= 100.0
                if yes_prob is None and no_prob is not None:
                    yes_prob = 1.0 - no_prob
                if yes_prob is None:
                    return None
                if yes_prob < 0 or yes_prob > 1.2:
                    return None
                return max(0.0, min(1.0, yes_prob))
        else:
            prices = _parse_jsonish_list(prices_raw)

        if not outcomes or not prices or len(outcomes) != len(prices):
            # Some payloads embed outcome probabilities directly in the outcomes list.
            if outcomes and all(isinstance(o, dict) for o in outcomes):
                labels = []
                parsed_prices = []
                for o in outcomes:
                    label = str(o.get("name") or o.get("label") or o.get("outcome") or "").strip().lower()
                    pv = o.get("price") if ("price" in o) else o.get("probability")
                    try:
                        p = float(pv) if pv is not None else float("nan")
                    except Exception:
                        p = float("nan")
                    labels.append(label)
                    parsed_prices.append(p)
                # Continue through the normal label matching below.
                outcomes = labels
                prices = parsed_prices
            else:
                return None

        parsed_prices = []
        for p in prices:
            try:
                parsed_prices.append(float(p))
            except Exception:
                parsed_prices.append(float("nan"))
        if not any(p == p for p in parsed_prices):  # all NaN
            return None

        # Gamma sometimes returns prices in percent (0..100) rather than 0..1.
        finite_prices = [p for p in parsed_prices if p == p]
        if finite_prices:
            mx = max(finite_prices)
            mn = min(finite_prices)
            if mx > 1.2 and 0 <= mn and mx <= 100:
                parsed_prices = [p / 100.0 if (p == p) else p for p in parsed_prices]

        yes_prob = None
        no_prob = None
        for o, p in zip(outcomes, parsed_prices):
            if not (p == p):
                continue
            label = ""
            if isinstance(o, dict):
                label = str(o.get("name") or o.get("label") or o.get("outcome") or "").strip().lower()
            else:
                label = str(o).strip().lower()
            if label == "yes":
                yes_prob = p
            elif label == "no":
                no_prob = p

        # If the market is a standard YES/NO binary and we only found NO, infer YES.
        if yes_prob is None and no_prob is not None:
            yes_prob = 1.0 - no_prob

        # If we still can't identify a YES probability, skip the market (avoid accidentally using "NO").
        if yes_prob is None:
            return None

        if yes_prob < 0 or yes_prob > 1.2:
            return None
        return max(0.0, min(1.0, yes_prob))

    def _market_url_from(m):
        slug = (m.get("slug") or "").strip()
        return f"https://polymarket.com/market/{slug}" if slug else "https://polymarket.com/"

    try:
        candidates = []
        any_ok_response = False

        # Time-window: only consider markets resolving in the next 48 hours.
        now_ts = int(utc_now().timestamp())
        cutoff_ts = now_ts + 48 * 3600

        def _extract_resolution_ts(obj):
            """
            Try common fields to find a resolution/close timestamp.
            Returns integer epoch seconds, or None if not found/parsable.
            """
            if not isinstance(obj, (dict,)):
                return None
            keys = [
                "closeTime", "close_time", "resolutionTime", "resolution_time", "endTime", "end_time",
                "eventClose", "eventCloseAt", "resolveTime", "resolutionDate", "endDate", "ends_at", "close_at",
                "resolution_at", "event_end", "event_close"
            ]
            for k in keys:
                if k not in obj:
                    continue
                v = obj.get(k)
                if v is None:
                    continue
                # Numeric epoch (seconds or ms)
                try:
                    if isinstance(v, (int, float)):
                        t = int(v)
                        # if it's obviously ms, convert to seconds
                        if t > 10 ** 12:
                            t = t // 1000
                        return t
                    s = str(v).strip()
                    if not s:
                        continue
                    # digits only?
                    if re.fullmatch(r"\d{10,16}", s):
                        t = int(s)
                        if t > 10 ** 12:
                            t = t // 1000
                        return t
                    # Try ISO/RFC parsing
                    try:
                        dt = parsedate_to_datetime(s)
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=datetime.timezone.utc)
                        return int(dt.timestamp())
                    except Exception:
                        # fallback: fromisoformat (handles YYYY-MM-DDTHH:MM:SS)
                        try:
                            dt = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
                            if dt.tzinfo is None:
                                dt = dt.replace(tzinfo=datetime.timezone.utc)
                            return int(dt.timestamp())
                        except Exception:
                            continue
                except Exception:
                    continue
            return None

        def _resolves_within_48h(market_obj, event_obj=None):
            """
            Returns True if resolution timestamp for market_obj or containing event_obj
            exists and falls within now..cutoff_ts. Otherwise False.
            """
            ts = _extract_resolution_ts(market_obj)
            if ts is None and isinstance(event_obj, dict):
                ts = _extract_resolution_ts(event_obj)
            if ts is None:
                return False
            return now_ts <= ts <= cutoff_ts

        # Prefer the official search endpoint used by polymarket.com.
        # Docs: https://docs.polymarket.com/#search
        pm_headers = {"Accept": "application/json", "Referer": "https://polymarket.com/", "Origin": "https://polymarket.com"}
        # Keep Polymarket discovery tightly focused on Iran as the primary search.
        # (Avoid broad geopolitics queries that can bias results toward non-Iran headlines.)
        search_queries = [
            "iran",
            "iran strike",
            "iran attack",
            "tehran",
            "strait of hormuz",
            "hormuz",
        ]

        seen_slugs = set()

        def _title_is_relevant(title):
            tl = str(title or "").strip().lower()
            if not tl:
                return False
            # Primary Iran/Hormuz context.
            if any(k in tl for k in ("iran", "tehran", "hormuz", "strait of hormuz")):
                return True
            # Secondary: Israel-related strike markets can be Iran escalation signals even when "Iran"
            # is not explicitly in the question.
            strike_terms = ("strike", "airstrike", "attack", "war", "retaliat", "missile", "drone", "uav", "bomb")
            if ("israel" in tl or "us" in tl) and any(k in tl for k in strike_terms):
                return True
            return False

        def _score_market(q):
            ql = q.lower()
            relevance = 0
            if any(k in ql for k in ("iran", "tehran")):
                relevance += 2
            if any(k in ql for k in ("strike", "attack", "airstrike", "war", "retaliat", "missile", "drone", "uav")):
                relevance += 6
            if any(k in ql for k in ("hormuz", "gulf of oman", "persian gulf", "shipping", "tanker")):
                relevance += 2
            return relevance

        for q in search_queries:
            # Keep params minimal for compatibility; filter client-side.
            url = f"https://gamma-api.polymarket.com/public-search?q={requests.utils.quote(q)}&keep_closed_markets=0&limit_per_type=40&optimized=true"
            r = None
            for attempt in range(3):
                try:
                    r = _http_get(url, timeout=25, extra_headers=pm_headers)
                except Exception:
                    r = None
                if r is None:
                    time.sleep(0.5 + attempt * 0.7)
                    continue
                if r.status_code in (429, 500, 502, 503, 504):
                    time.sleep(0.7 + attempt * 1.1)
                    continue
                break

            if not r or r.status_code != 200:
                continue

            try:
                payload = r.json()
            except Exception:
                continue

            if not isinstance(payload, (dict, list)):
                continue
            any_ok_response = True

            # Some variants can return a top-level list; treat it as a list of markets.
            if isinstance(payload, list):
                payload = {"markets": payload}

            # public-search can return both `markets` and `events` (with nested markets)
            direct_markets = payload.get("markets")
            if isinstance(direct_markets, list):
                for m in direct_markets[:200]:
                    if not isinstance(m, dict):
                        continue
                    if m.get("closed") is True:
                        continue
                    if m.get("active") is False:
                        continue
                    title = (m.get("question") or m.get("title") or "").strip()
                    if not title:
                        continue
                    if not _title_is_relevant(title):
                        continue
                    slug = (m.get("slug") or "").strip()
                    if slug and slug in seen_slugs:
                        continue
                    if slug:
                        seen_slugs.add(slug)

                    # NEW: only consider markets resolving within next 48 hours
                    if not _resolves_within_48h(m):
                        continue

                    yes_prob = _extract_yes_prob(m)
                    if yes_prob is None:
                        continue
                    vol = 0.0
                    liq = 0.0
                    for k in ("volume24hr", "volume", "volumeUsd", "volume_usd", "volume24h"):
                        try:
                            if m.get(k) is not None:
                                vol = float(m.get(k))
                                break
                        except Exception:
                            pass
                    for k in ("liquidity", "liquidityNum", "liquidityUsd", "liquidity_usd"):
                        try:
                            if m.get(k) is not None:
                                liq = float(m.get(k))
                                break
                        except Exception:
                            pass
                    relevance = _score_market(title)
                    market_url = _market_url_from(m)
                    score = ((vol * 1.0) + (liq * 0.2) + 1.0) * (1.0 + 0.18 * relevance)
                    candidates.append((score, yes_prob, title, market_url))

            events = payload.get("events")
            if isinstance(events, list):
                for ev in events[:80]:
                    if not isinstance(ev, dict):
                        continue
                    markets = ev.get("markets") or []
                    if not isinstance(markets, list):
                        continue
                    for m in markets:
                        if not isinstance(m, dict):
                            continue
                        if m.get("closed") is True:
                            continue
                        if m.get("active") is False:
                            continue
                        title = (m.get("question") or m.get("title") or ev.get("title") or "").strip()
                        if not title:
                            continue
                        if not _title_is_relevant(title):
                            continue
                        slug = (m.get("slug") or "").strip()
                        if slug and slug in seen_slugs:
                            continue
                        if slug:
                            seen_slugs.add(slug)

                        # NEW: consider market OR parent event resolution, and require within 48h
                        if not _resolves_within_48h(m, event_obj=ev):
                            continue

                        yes_prob = _extract_yes_prob(m)
                        if yes_prob is None:
                            continue
                        vol = 0.0
                        liq = 0.0
                        for k in ("volume24hr", "volume", "volume", "volumeUsd", "volume_usd", "volume24h"):
                            try:
                                if m.get(k) is not None:
                                    vol = float(m.get(k))
                                    break
                            except Exception:
                                pass
                        for k in ("liquidity", "liquidityNum", "liquidityUsd", "liquidity_usd"):
                            try:
                                if m.get(k) is not None:
                                    liq = float(m.get(k))
                                    break
                            except Exception:
                                pass
                        relevance = _score_market(title)
                        market_url = _market_url_from(m)
                        score = ((vol * 1.0) + (liq * 0.2) + 1.0) * (1.0 + 0.18 * relevance)
                        candidates.append((score, yes_prob, title, market_url))

        # Fallback: listing endpoint (best-effort)
        if not candidates:
            for offset in (0, 100, 200):
                url = f"https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&offset={offset}"
                r = None
                for attempt in range(3):
                    try:
                        r = _http_get(url, timeout=25, extra_headers=pm_headers)
                    except Exception:
                        r = None
                    if r is None:
                        time.sleep(0.5 + attempt * 0.7)
                        continue
                    if r.status_code in (429, 500, 502, 503, 504):
                        time.sleep(0.7 + attempt * 1.1)
                        continue
                    break
                if not r or r.status_code != 200:
                    continue
                try:
                    data = r.json()
                except Exception:
                    continue
                if not isinstance(data, (dict, list)):
                    continue
                any_ok_response = True
                if isinstance(data, dict):
                    data = data.get("data") or data.get("markets") or []
                if not isinstance(data, list):
                    continue
                for m in data:
                    if not isinstance(m, dict):
                        continue
                    title = (m.get("question") or m.get("title") or "").strip()
                    if not title:
                        continue
                    if not _title_is_relevant(title):
                        continue

                    # NEW: require resolution within 48 hours for fallback too
                    if not _resolves_within_48h(m):
                        continue

                    yes_prob = _extract_yes_prob(m)
                    if yes_prob is None:
                        continue
                    relevance = _score_market(title)
                    market_url = _market_url_from(m)
                    candidates.append((1.0 + 0.18 * relevance, yes_prob, title, market_url))
                if len(candidates) >= 10:
                    break

        if not candidates:
            search_terms = ["iran", "iran strike", "iran attack", "tehran", "strait of hormuz", "hormuz"]
            search_sources = [{"title": f"Search: {t}", "url": _pm_search_url(t)} for t in search_terms]
            # If we couldn't reach the API at all (CDN blocks, endpoint changes, etc.),
            # don't claim there are "no active markets" — provide a manual search link instead.
            if not any_ok_response:
                out = {
                    "odds": None,
                    "available": False,
                    "market": "Polymarket search unavailable",
                    "url": _pm_search_url("iran"),
                    "timestamp": utc_iso(),
                }
                out["sources"] = search_sources
                return out

            out = {
                "odds": None,
                "available": False,
                "market": "No auto-selected Polymarket market (see search)",
                "url": _pm_search_url("iran"),
                "timestamp": utc_iso(),
            }
            out["sources"] = search_sources
            return out

        candidates.sort(key=lambda x: x[0], reverse=True)
        top = candidates[:8]
        _, prob, question, market_url = top[0]
        odds = round(float(prob) * 100.0, 1)

        out = {
            "odds": odds,
            "available": True,
            "market": question,
            "url": market_url,
            "timestamp": utc_iso(),
        }
        # Include multiple matched market links so the UI can show more context.
        out["sources"] = [{"title": q, "url": u} for _, _, q, u in top if q and u]
        return out
    except Exception:
        out = {
            "odds": None,
            "available": False,
            "market": "Polymarket unavailable",
            "url": "https://polymarket.com/",
            "timestamp": utc_iso(),
        }
        out["sources"] = [{"title": out["market"], "url": out["url"]}]
        return out
# ... rest of file unchanged ...
def build_public_interest():
    gdelt_articles = 0
    gdelt_tone = 0.0
    wiki_views = 0
    gdelt_worked = False
    wiki_worked = False

    # GDELT (24h)
    try:
        gdelt_query = "iran attack OR iran strike OR iran military OR iran us"
        gdelt_url = (
            "https://api.gdeltproject.org/api/v2/doc/doc"
            f"?query={requests.utils.quote(gdelt_query)}&mode=artlist&maxrecords=50&format=json&timespan=24h"
        )
        r = _http_get(gdelt_url, timeout=15)
        if r.status_code == 200 and r.text and r.text.lstrip().startswith("{"):
            j = r.json()
            arts = j.get("articles") or []
            if isinstance(arts, list):
                gdelt_articles = len(arts)
                tones = []
                for a in arts:
                    try:
                        t = float(a.get("tone", 0) or 0)
                        if t != 0:
                            tones.append(t)
                    except Exception:
                        pass
                if tones:
                    gdelt_tone = sum(tones) / len(tones)
                gdelt_worked = True
    except Exception:
        pass

    # Wikipedia pageviews (yesterday)
    try:
        yesterday = (utc_now() - datetime.timedelta(days=1)).strftime("%Y%m%d")
        pages = ["Iran", "Iran%E2%80%93United_States_relations", "Iran%E2%80%93Israel_conflict"]
        total = 0
        for page in pages:
            try:
                url = (
                    "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
                    f"en.wikipedia/all-access/all-agents/{page}/daily/{yesterday}/{yesterday}"
                )
                r = _http_get(url, timeout=15)
                if r.status_code == 200:
                    j = r.json()
                    items = (j.get("items") or [])
                    if items and isinstance(items, list) and isinstance(items[0], dict):
                        total += int(items[0].get("views") or 0)
                        wiki_worked = True
            except Exception:
                pass
        wiki_views = total
    except Exception:
        pass

    gdelt_risk = 0.0
    wiki_risk = 0.0

    if gdelt_worked:
        if gdelt_articles <= 10:
            gdelt_risk = 1 + gdelt_articles * 0.2
        elif gdelt_articles <= 25:
            gdelt_risk = 3 + (gdelt_articles - 10) * 0.27
        else:
            gdelt_risk = 7 + (gdelt_articles - 25) * 0.2
        if gdelt_tone < -5:
            gdelt_risk += 3
        elif gdelt_tone < -3:
            gdelt_risk += 1.5
        gdelt_risk = min(12, gdelt_risk)

    if wiki_worked and wiki_views > 0:
        if wiki_views < 20000:
            wiki_risk = 1 + (wiki_views / 15000)
        elif wiki_views < 50000:
            wiki_risk = 2.5 + ((wiki_views - 20000) / 10000)
        elif wiki_views < 100000:
            wiki_risk = 5.5 + ((wiki_views - 50000) / 8000)
        else:
            wiki_risk = 12 + ((wiki_views - 100000) / 50000)
        wiki_risk = min(13, wiki_risk)

    # Frontend clamps interest to 0..20
    total_risk = min(20.0, gdelt_risk + wiki_risk + 1)

    detail_parts = []
    if gdelt_worked:
        detail_parts.append(f"{gdelt_articles} GDELT")
    if wiki_worked:
        detail_parts.append(f"{round(wiki_views/1000)}k Wiki")
    detail = ", ".join(detail_parts) if detail_parts else "Monitoring..."

    return {
        "interest": float(total_risk),
        "socialDetail": detail,
        "gdelt": {"articles": int(gdelt_articles), "tone": float(gdelt_tone), "worked": bool(gdelt_worked)},
        "wiki": {"views": int(wiki_views), "worked": bool(wiki_worked)},
        "timestamp": utc_iso(),
    }