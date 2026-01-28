
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
    r"\b(iran|tehran|irgc|israel|tel aviv|jerusalem|united states|u\.s\.|centcom|pentagon|hezbollah|hamas|houthi|syria|iraq|yemen|gulf|hormuz)\b",
    re.I,
)
NEWS_ALERT_RE = re.compile(
    r"\b(retaliat|strike|attack|escalat|threat|imminent|missile|drone|uav|nuclear|war|airstrike|bomb|intercept|invasion)\b",
    re.I,
)

def _http_get(url, timeout=15):
    headers = {
        "User-Agent": "BetterLife/1.0 (+https://{PLACEHOLDER}.github.io/{placeholder})",
        "Accept": "*/*",
    }
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
        text = f"{it.get('title','')} {it.get('description','')}".strip()
        if not text:
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

def fetch_polymarket_signal():
    """
    Fetch a single Polymarket market odds snapshot (best-match heuristic).

    Uses Polymarket's public Gamma API (no key). Always returns an object with
    an `odds` number so the UI doesn't get stuck on "Awaiting data".
    """
    try:
        candidates = []

        # Pull a small window of active markets and pick the best match by keywords + volume/liquidity.
        for offset in (0, 100, 200):
            url = f"https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&offset={offset}"
            r = _http_get(url, timeout=20)
            if r.status_code != 200:
                continue
            data = r.json()
            if not isinstance(data, list):
                continue

            for m in data:
                if not isinstance(m, dict):
                    continue
                q = (m.get("question") or m.get("title") or "").strip()
                ql = q.lower()
                if not q:
                    continue
                if ("iran" not in ql) and ("tehran" not in ql):
                    continue
                relevance = 0
                if any(k in ql for k in ("strike", "attack", "airstrike", "war", "retaliat", "missile", "drone", "uav")):
                    relevance += 5
                if any(k in ql for k in ("israel", "tel aviv", "jerusalem")):
                    relevance += 3
                if any(k in ql for k in ("u.s", "united states", "us", "pentagon", "centcom")):
                    relevance += 2

                outcomes = _parse_jsonish_list(m.get("outcomes"))
                prices = _parse_jsonish_list(m.get("outcomePrices") or m.get("outcome_prices"))
                if not outcomes or not prices or len(outcomes) != len(prices):
                    continue

                parsed_prices = []
                for p in prices:
                    try:
                        parsed_prices.append(float(p))
                    except Exception:
                        parsed_prices.append(float("nan"))
                if not any(p == p for p in parsed_prices):  # all NaN
                    continue

                yes_prob = None
                for o, p in zip(outcomes, parsed_prices):
                    if not (p == p):
                        continue
                    if str(o).strip().lower() == "yes":
                        yes_prob = p
                        break
                if yes_prob is None:
                    yes_prob = max([p for p in parsed_prices if p == p] or [0.0])

                # Basic sanity clamp (Gamma prices are typically 0..1)
                if yes_prob < 0 or yes_prob > 1.2:
                    continue
                yes_prob = max(0.0, min(1.0, yes_prob))

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

                slug = (m.get("slug") or "").strip()
                market_url = f"https://polymarket.com/market/{slug}" if slug else "https://polymarket.com/"

                score = ((vol * 1.0) + (liq * 0.2)) * (1.0 + 0.12 * relevance)
                candidates.append((score, yes_prob, q, market_url))

            # If we already found a good set of candidates, stop paging.
            if len(candidates) >= 10:
                break

        if not candidates:
            return {
                "odds": 0,
                "market": "No active Iran-related market matched",
                "url": "https://polymarket.com/",
                "timestamp": utc_iso(),
            }

        candidates.sort(key=lambda x: x[0], reverse=True)
        _, prob, question, market_url = candidates[0]
        odds = int(round(prob * 100))

        return {
            "odds": odds,
            "market": question,
            "url": market_url,
            "timestamp": utc_iso(),
        }
    except Exception:
        return {
            "odds": 0,
            "market": "Polymarket unavailable",
            "url": "https://polymarket.com/",
            "timestamp": utc_iso(),
        }

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

def build_aviation_signal():
    try:
        # Iran airspace bounding box
        url = "https://opensky-network.org/api/states/all?lamin=25&lomin=44&lamax=40&lomax=64"
        r = _http_get(url, timeout=20)
        if r.status_code != 200:
            raise Exception("OpenSky API error")
        j = r.json()
        states = j.get("states") or []
        civil_count = 0
        airlines = set()
        usaf_start = int("AE0000", 16)
        usaf_end = int("AE7FFF", 16)
        for ac in states:
            try:
                icao = ac[0]
                callsign = (ac[1] or "").strip()
                on_ground = ac[8]
                if on_ground:
                    continue
                icao_num = int(icao, 16)
                if usaf_start <= icao_num <= usaf_end:
                    continue
                civil_count += 1
                if len(callsign) >= 3:
                    airlines.add(callsign[:3])
            except Exception:
                continue

        # Map to 0..15 contribution (frontend expects 0..15)
        if civil_count == 0:
            contribution = 15
        elif civil_count < 5:
            contribution = 12
        elif civil_count < 15:
            contribution = 8
        elif civil_count < 30:
            contribution = 4
        else:
            contribution = 1

        return {
            "aviation": float(contribution),
            "aviation_count": int(civil_count),
            "aviation_airlines": sorted(list(airlines))[:12],
            "flightDetail": f"{civil_count} aircraft over Iran",
            "timestamp": utc_iso(),
        }
    except Exception:
        return {
            "aviation": 5.0,
            "aviation_count": 0,
            "aviation_airlines": [],
            "flightDetail": "Awaiting data...",
            "timestamp": utc_iso(),
        }

def build_military_signal():
    try:
        url = "https://opensky-network.org/api/states/all?lamin=15&lomin=34&lamax=42&lomax=64"
        r = _http_get(url, timeout=20)
        if r.status_code != 200:
            raise Exception("OpenSky API error")
        j = r.json()
        states = j.get("states") or []
        military_count = 0
        tanker_like = 0

        usaf_start = int("AE0000", 16)
        usaf_end = int("AE7FFF", 16)
        tanker_re = re.compile(r"\b(TEXACO|SHELL|MOOSE|TEAM|GOLD|NACHO|ARCO)\b", re.I)

        for ac in states:
            try:
                icao = ac[0]
                callsign = (ac[1] or "").strip()
                on_ground = ac[8]
                if on_ground or not icao:
                    continue
                icao_num = int(icao, 16)
                is_us_mil = usaf_start <= icao_num <= usaf_end
                is_tanker = bool(tanker_re.search(callsign))
                if not is_us_mil and not is_tanker:
                    continue
                military_count += 1
                if is_tanker:
                    tanker_like += 1
            except Exception:
                continue

        contribution = 1.0
        if military_count > 0:
            contribution = 1 + military_count * 2 + tanker_like * 1.5
        contribution = min(15.0, float(contribution))

        detail = "No tracked assets detected" if military_count == 0 else (
            f"{military_count} tracked assets" + (f" ({tanker_like} tanker-like)" if tanker_like else "")
        )

        return {
            "military": float(contribution),
            "military_count": int(military_count),
            "military_tanker_like": int(tanker_like),
            "militaryDetail": detail,
            "timestamp": utc_iso(),
        }
    except Exception:
        return {
            "military": 1.0,
            "military_count": 0,
            "military_tanker_like": 0,
            "militaryDetail": "Awaiting data...",
            "timestamp": utc_iso(),
        }

def build_weather_tehran():
    try:
        lat = 35.6892
        lon = 51.3890
        url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}&current=cloud_cover,precipitation,visibility,wind_speed_10m,temperature_2m&timezone=UTC"
        )
        r = _http_get(url, timeout=15)
        if r.status_code != 200:
            raise Exception("Open-Meteo error")
        j = r.json()
        cur = j.get("current") or {}

        clouds = float(cur.get("cloud_cover", 100) or 100)
        wind = float(cur.get("wind_speed_10m", 0) or 0)
        visibility = float(cur.get("visibility", 10000) or 10000)
        precip = float(cur.get("precipitation", 0) or 0)
        temp_c = cur.get("temperature_2m", None)

        favorable = clouds <= 30 and wind <= 7 and precip <= 0.2 and visibility >= 8000
        marginal = clouds <= 60 and wind <= 10 and precip <= 1 and visibility >= 4000

        condition = "Favorable" if favorable else "Marginal" if marginal else "Poor"
        contribution = 5 if condition == "Favorable" else 3 if condition == "Marginal" else 1

        parts = []
        if temp_c is not None:
            try:
                parts.append(f"{round(float(temp_c))}°C")
            except Exception:
                pass
        parts.append(f"clouds {round(clouds)}%")
        if precip > 0:
            parts.append(f"precip {precip:.1f}mm/h")
        if visibility != 10000:
            parts.append(f"vis {round(visibility/1000)}km")
        detail = "Tehran: " + ", ".join(parts)

        return {
            "weather": float(contribution),
            "weatherCondition": condition,
            "weatherDetail": detail,
            "weatherFetched": True,
            "timestamp": utc_iso(),
        }
    except Exception:
        return {
            "weather": 1.0,
            "weatherCondition": "Poor",
            "weatherDetail": "Weather unavailable",
            "weatherFetched": False,
            "timestamp": utc_iso(),
        }

def compute_osint_gps_diplomats_from_articles(articles):
    if not isinstance(articles, list) or not articles:
        return {
            "gps": {"count": 0, "critical": 0, "contribution": 0.5, "detail": "No spoofing/jamming reports detected"},
            "diplomats": {"count": 0, "critical": 0, "contribution": 0.5, "detail": "No diplomatic movement signals detected"},
        }

    war_context_re = re.compile(r"(strike|attack|airstrike|bomb|missile|drone|war|retaliat|escalat|imminent|hostilit)", re.I)
    gps_re = re.compile(r"(gps|gnss)", re.I)
    interference_re = re.compile(r"(spoof|jamm|interference|spoofing|jamming)", re.I)
    ew_re = re.compile(r"(electronic warfare|\bew\b|jamming campaign|signal interference)", re.I)

    dip_anchor_re = re.compile(r"(diplomat|diplomatic|embassy|consulate|ambassador|charg[ée] d'affaires|mission staff)", re.I)
    dip_move_re = re.compile(r"(evacuat|ordered departure|withdraw|relocat|transfer|reassign|sent home|recalled|closed|shut(ting)?|downsizing)", re.I)
    dip_critical_re = re.compile(r"(ordered departure|evacuat|withdraw|closed embassy|embassy closure)", re.I)

    gps_count = 0
    gps_critical = 0
    dip_count = 0
    dip_critical = 0

    for a in articles:
        if not isinstance(a, dict):
            continue
        text = f"{a.get('title','')} {a.get('description','')} {a.get('content','')}".strip()
        if not text:
            continue

        gps_hit = bool(gps_re.search(text) and interference_re.search(text))
        if gps_hit:
            gps_count += 1
            if ew_re.search(text) or war_context_re.search(text):
                gps_critical += 1

        dip_hit = bool(dip_anchor_re.search(text) and dip_move_re.search(text))
        if dip_hit:
            dip_count += 1
            if dip_critical_re.search(text) or war_context_re.search(text):
                dip_critical += 1

    gps_contrib = min(8.0, 0.5 + gps_count * 2 + gps_critical * 1)
    dip_contrib = min(12.0, 0.5 + dip_count * 3 + dip_critical * 2)

    gps_detail = "No spoofing/jamming reports detected" if gps_count == 0 else f"{gps_count} reports, {gps_critical} high-signal"
    dip_detail = "No diplomatic movement signals detected" if dip_count == 0 else f"{dip_count} items, {dip_critical} high-signal"

    return {
        "gps": {"count": int(gps_count), "critical": int(gps_critical), "contribution": float(gps_contrib), "detail": gps_detail},
        "diplomats": {"count": int(dip_count), "critical": int(dip_critical), "contribution": float(dip_contrib), "detail": dip_detail},
    }

# Market Symbols (Yahoo Finance)
# S&P 500: ^GSPC
# Israel ETF (tracking TA-35): EIS
# Bitcoin: BTC-USD
# Ethereum: ETH-USD
MARKET_TICKERS = {
    "US": "^GSPC",
    "ISRAEL": "EIS",
    "BITCOIN": "BTC-USD",
    "ETHEREUM": "ETH-USD",
}

# -----------------------------------------------------------------------------
# Maritime NtM (Notices to Mariners) / Hormuz Indicator
# -----------------------------------------------------------------------------
def compute_maritime_ntm_from_articles(articles):
    """
    Derive a coarse 'Maritime NtM (Hormuz)' signal from the cached news batch.

    This does NOT fetch official NAVAREA feeds. It scans titles/descriptions for
    maritime advisory / navigation warning language + Strait of Hormuz context.
    """
    if not isinstance(articles, list) or not articles:
        return {
            "score": 0.0,
            "count": 0,
            "critical": 0,
            "detail": "No Hormuz maritime advisories detected",
            "samples": [],
            "timestamp": utc_iso(),
        }

    import re

    hormuz_re = re.compile(r"(strait of hormuz|\bhormuz\b|gulf of oman|persian gulf|musandam|qeshm|bandar abbas)", re.I)
    ntm_re = re.compile(r"(notice(?:s)? to mariners|\bntm\b|navarea|navtex|navigational warning|nav warning|maritime safety information|\bmsi\b|shipping advisory|maritime (security )?advisory|ukmto|msc-hoa|imac)", re.I)
    critical_re = re.compile(r"(avoid|do not transit|do not proceed|suspend|closure|closed|mines?|mine threat|missile|drone|uav|attack|seiz|board(?:ing)?|hijack|explosion|harass|intercept|armed|warship|irgc|\bnavy\b|tanker)", re.I)

    count = 0
    critical = 0
    samples = []

    for a in articles:
        if not isinstance(a, dict):
            continue
        text = f"{a.get('title','')} {a.get('description','')} {a.get('content','')}".strip()
        if not text:
            continue

        if hormuz_re.search(text) and ntm_re.search(text):
            count += 1
            if critical_re.search(text):
                critical += 1
            title = (a.get("title") or "").strip()
            if title and len(samples) < 3:
                samples.append(title)

    # Score mapping (max 12) to match frontend cap
    score = min(12, 0.5 + count * 3 + critical * 2)
    detail = "No Hormuz maritime advisories detected" if count == 0 else f"{count} items, {critical} high-signal"

    return {
        "score": float(score),
        "count": int(count),
        "critical": int(critical),
        "detail": detail,
        "samples": samples,
        "timestamp": utc_iso(),
    }

# -----------------------------------------------------------------------------
# NOTAM / Airspace Logic
# -----------------------------------------------------------------------------
def check_airspace_warnings(aviation_count=None):
    """
    Checks for critical airspace warnings in Tehran (OIIX) and Tel Aviv (LLLL).
    Uses public data sources or known status if direct API is unavailable.
    """
    print("Checking Airspace Warnings (NOTAMs)...")

    # NOTE: This module does not currently ingest live FIR NOTAM feeds.
    # We still score the signal by a typed severity model so the UI/feed can
    # explain "why" the number is what it is.

    # Type-based scoring model (0..50 raw; frontend maps to max 15% contribution)
    TYPE_SCORES = {
        "FIR_PROHIBITED": 40,      # no-fly / prohibited / closed FIR
        "FIR_RESTRICTED": 28,      # restricted airspace / route closure
        "FIR_CAUTION": 10,         # caution advisory
        "AERODROME_CLOSED": 20,    # airport closed (runway/aerodrome)
        "SECURITY_WARNING": 12,    # security risk advisory (non-closure)
        "UNKNOWN": 0,
    }

    def make_notam(fir, label, notam_type, severity, message):
        return {
            "fir": fir,
            "label": label,
            "type": notam_type,
            "severity": severity,
            "score": int(TYPE_SCORES.get(notam_type, 0)),
            "message": message,
        }

    notams = []

    # Tehran (OIIX) - heuristic based on observed civil traffic in the FIR box
    # IMPORTANT: NOTAMs can exist without closing the FIR (corridors, altitudes, warnings).
    # If we still see normal traffic levels, downgrade to CAUTION/SECURITY_WARNING.
    tehran_status = 1  # default: caution (avoid claiming full closure without a live NOTAM feed)
    if aviation_count is not None:
        try:
            c = int(aviation_count)
            if c < 5:
                tehran_status = 2  # severe restriction indicator
            elif c < 15:
                tehran_status = 1  # reduced traffic
            else:
                tehran_status = 1  # normal-ish traffic => treat as caution only
        except Exception:
            pass

    if tehran_status == 2:
        notams.append(make_notam(TEHRAN_FIR, "Tehran FIR", "FIR_RESTRICTED", "WARNING", f"{TEHRAN_FIR} (Tehran) shows restriction indicators (low observed traffic)."))
    else:
        notams.append(make_notam(TEHRAN_FIR, "Tehran FIR", "SECURITY_WARNING", "NOTICE", f"{TEHRAN_FIR} (Tehran) has active advisories (NOTAMs may not close the FIR)."))

    # Tel Aviv (LLLL) - keep as caution unless you integrate a live NOTAM feed
    notams.append(make_notam(TEL_AVIV_FIR, "Tel Aviv FIR", "FIR_CAUTION", "NOTICE", f"{TEL_AVIV_FIR} (Tel Aviv) has caution advisories."))

    raw_score = sum(int(n.get("score") or 0) for n in notams)
    raw_score = max(0, min(50, raw_score))

    # Extra rule: if NOTAMs exist but traffic is still very high, reduce severity.
    # User requirement: if there is NOTAM and >50 civil aircraft (proxy: current OpenSky count),
    # lower the score (NOTAMs may be corridor/altitude advisories, not full closures).
    if raw_score > 0 and aviation_count is not None:
        try:
            if int(aviation_count) > 50:
                raw_score = int(round(raw_score * 0.4))
        except Exception:
            pass

    details = []
    for n in notams:
        sev = (n.get("severity") or "").strip().upper() or "NOTICE"
        typ = (n.get("type") or "UNKNOWN").strip().upper()
        msg = (n.get("message") or "").strip()
        details.append(f"{sev}: {msg} [type={typ}]")

    status = "Restricted" if any(n.get("type") in ("FIR_PROHIBITED", "FIR_RESTRICTED") for n in notams) else ("Caution" if raw_score > 0 else "Normal")
    if raw_score > 0 and aviation_count is not None:
        try:
            if int(aviation_count) > 50:
                status = "Caution"
        except Exception:
            pass

    print(f"  Airspace Score Contribution: {raw_score}")
    for d in details:
        print(f"  - {d}")

    # Summarize by type for downstream explanations
    type_counts = {}
    for n in notams:
        t = n.get("type") or "UNKNOWN"
        type_counts[t] = int(type_counts.get(t, 0)) + 1

    return {
        "score": int(raw_score),
        "details": details,
        "notams": notams,
        "type_counts": type_counts,
        "heuristic": True,
        "note": "This is a heuristic severity estimate. NOTAMs can exist without closing the FIR; observed traffic is used as a sanity check.",
        "aviation_count": int(aviation_count) if isinstance(aviation_count, int) else aviation_count,
        "status": status,
        "fir_codes": [TEHRAN_FIR, TEL_AVIV_FIR],
        "source_url": "https://notams.aim.faa.gov/notamSearch/",
        "timestamp": utc_iso(),
    }

# -----------------------------------------------------------------------------
# Market Logic
# -----------------------------------------------------------------------------
def check_market_status():
    """
    Checks if major markets (US & Israel) are 'Red' (Negative).
    """
    print("\nChecking Global Market Status...")
    
    market_data = {}
    red_market_count = 0
    details = []
    market_score = 0
    
    if not yf:
        print("  WARNING: 'yfinance' library not found. Please install checks for live data.")
        return {"score": 0, "status": "Unknown", "details": ["Missing yfinance lib"], "data": {}}
        
    for region, ticker in MARKET_TICKERS.items():
        try:
            ticker_obj = yf.Ticker(ticker)
            # Get today's data (fastest way)
            hist = ticker_obj.history(period="5d")
            
            if len(hist) < 2:
                print(f"  Insufficient data for {ticker}")
                continue
                
            # Get latest close and previous close
            latest = hist.iloc[-1]
            prev = hist.iloc[-2]
            
            change = ((latest['Close'] - prev['Close']) / prev['Close']) * 100
            
            status = "GREEN" if change >= 0 else "RED"
            market_data[region] = {
                "change_percent": change,
                "status": status,
                "price": float(latest['Close'])
            }
            
            print(f"  {region} ({ticker}): {status} ({change:+.2f}%)")
            
            if status == "RED":
                red_market_count += 1
                if change < -1.0: # Significant drop
                    details.append(f"{region} SIGNIFICANT DROP ({change:.2f}%)")
                else:
                    details.append(f"{region} down ({change:.2f}%)")
            else:
                 details.append(f"{region} up (+{change:.2f}%)")
            
        except Exception as e:
            print(f"  Error fetching {ticker}: {e}")
            
    # Risk Calculation based on "Red Market" theory
    if red_market_count == len(MARKET_TICKERS):
        market_score = 30 # High correlation indicator
        print("  > Both markets are RED. War potential indicator ACTIVE.")
    elif red_market_count > 0:
        market_score = 10 # Mild indicator
        
    return {
        "score": market_score,
        "data": market_data,
        "details": details,
        "summary": f"{red_market_count} Red Markets" if red_market_count > 0 else "All Green",
        "timestamp": utc_iso()
    }

# -----------------------------------------------------------------------------
# Pentagon Pizza Logic (Integrated)
# -----------------------------------------------------------------------------
def get_pentagon_pizza_score():
    """
    Simulates or fetches Pentagon Pizza busyness.
    """
    print("\nChecking Pentagon Pizza Meter...")
    # Simulation Logic for now to keep it self-contained
    current_hour = datetime.datetime.now().hour
    current_day = datetime.datetime.now().weekday()
    
    base_score = 30
    status = "Normal"
    
     # Lunch rush
    if 11 <= current_hour <= 14 and current_day < 5:
        base_score = 50
        status = "Lunch Rush"
    # Dinner rush
    elif 17 <= current_hour <= 20:
        base_score = 55
        status = "Dinner Rush"
    # Late night (unusual)
    elif current_hour >= 22 or current_hour < 6:
        import hashlib
        day_hash = int(hashlib.md5(f"{datetime.datetime.now().date()}".encode()).hexdigest()[:8], 16)
        if day_hash % 10 < 2:  # 20% chance of elevated late-night activity simulation
            base_score = 70
            status = "High Activity (Late)"
        else:
            base_score = 20
            status = "Quiet"
            
    # Normalize to risk contribution (max 10% on frontend bar, but raw score 0-100)
    print(f"  Pentagon Pizza Score: {base_score} ({status})")
    
    return {
        "score": base_score,
        "status": status,
        "timestamp": utc_iso(),
        "is_late_night": current_hour >= 22 or current_hour < 6,
        "is_weekend": current_day >= 5
    }

# -----------------------------------------------------------------------------
# Data Save Logic
# -----------------------------------------------------------------------------
def save_data_locally(data, filename="strikeraedar_data.json"):
    """Save data to local JSON file as backup"""
    try:
        with open(filename, 'w') as f:
            json.dump(data, f, indent=2)
        print(f"\n  > Data saved locally to {filename}")
        return True
    except Exception as e:
        print(f"  > Error saving locally: {e}")
        return False

def write_local_cache(payload, path):
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            json.dump(payload, f, indent=2)
        print(f"  > Local cache written to {path}")
        return True
    except Exception as e:
        print(f"  > Error writing local cache: {e}")
        return False

# -----------------------------------------------------------------------------
# npoint.io Merge Logic (prevents overwriting dashboard cache)
# -----------------------------------------------------------------------------
def fetch_existing_npoint(npoint_id):
    try:
        res = requests.get(f"https://api.npoint.io/{npoint_id}", timeout=10)
        if res.status_code == 200:
            data = res.json()
            if isinstance(data, dict):
                return data
    except Exception as e:
        print(f"  > Warning: could not fetch existing npoint cache: {e}")
    return {}

def write_merged_payload(existing, updates, filename="strikeraedar_merged_payload.json"):
    merged = {}
    if isinstance(existing, dict):
        merged.update(existing)
    if isinstance(updates, dict):
        merged.update(updates)

    # Ensure dashboard-friendly timestamps (ms since epoch) + explicit UTC ISO.
    # Prefer the timestamp computed by the current run (so history timestamps match).
    if not isinstance(merged.get("strikeraedar_updated_ms"), int):
        now = utc_now()
        merged["strikeraedar_updated_ms"] = utc_ms(now)
        merged["strikeraedar_updated"] = utc_iso(now)
    if not isinstance(merged.get("strikeraedar_updated"), str):
        merged["strikeraedar_updated"] = utc_iso()
    merged["timestamp"] = int(merged.get("strikeraedar_updated_ms") or utc_ms())

    try:
        with open(filename, "w") as f:
            json.dump(merged, f, indent=2)
        print(f"\n  > Merged payload written to {filename}")
        return merged
    except Exception as e:
        print(f"  > Error writing merged payload: {e}")
        return merged

def push_to_npoint(npoint_id, payload):
    try:
        res = requests.post(
            f"https://api.npoint.io/{npoint_id}",
            headers={"Content-Type": "application/json"},
            data=json.dumps(payload),
            timeout=15,
        )
        if 200 <= res.status_code < 300:
            print("  > Pushed merged payload to npoint successfully.")
            return True
        print(f"  > Push failed: HTTP {res.status_code} {res.text[:200]}")
    except Exception as e:
        print(f"  > Push failed: {e}")
    return False

# -----------------------------------------------------------------------------
# Main Execution (StrikeRaedar)
# -----------------------------------------------------------------------------
def run_once(push=False, local_cache=False, local_cache_path="frontend/local_cache.json", npoint_id=NPOINT_ID):
    now = utc_now()
    print("="*60)
    print(f"StrikeRaedar Intelligence Module - {utc_iso(now)}")
    print("="*60)

    # Merge with existing npoint cache so we don't wipe unrelated fields.
    print("\nMerging with existing npoint cache (preserves history/links)...")
    existing = fetch_existing_npoint(npoint_id)

    # 1) Fetch sources (server-side, consistent for all users)
    news_intel = build_news_intel()
    interest = build_public_interest()
    aviation = build_aviation_signal()
    military = build_military_signal()
    weather = build_weather_tehran()

    # 2) Derived OSINT from the same news batch
    articles = news_intel.get("articles") or []
    maritime_ntm = compute_maritime_ntm_from_articles(articles)
    # If the 8h news window is empty, keep the last computed maritime value (avoid flapping to 0).
    if isinstance(existing.get("maritime_ntm"), dict) and (not isinstance(articles, list) or len(articles) == 0):
        maritime_ntm = existing.get("maritime_ntm")
    if not isinstance(maritime_ntm, dict):
        maritime_ntm = {
            "score": 0.0,
            "count": 0,
            "critical": 0,
            "detail": "No Hormuz maritime advisories detected",
            "samples": [],
            "timestamp": utc_iso(),
        }

    osint = compute_osint_gps_diplomats_from_articles(articles)

    # 3) Core signals
    airspace = check_airspace_warnings(aviation_count=aviation.get("aviation_count"))
    markets = check_market_status()
    pentagon = get_pentagon_pizza_score()

    # 4) Compute markets contribution (0..15) using the frontend thresholds
    markets_contrib = 0.0
    try:
        md = markets.get("data") or {}
        us_change = float((md.get("US") or {}).get("change_percent") or 0)
        il_change = float((md.get("ISRAEL") or {}).get("change_percent") or 0)
        btc_change = float((md.get("BITCOIN") or {}).get("change_percent") or 0)
        eth_change = float((md.get("ETHEREUM") or {}).get("change_percent") or 0)

        def score_from_change(change, thresholds):
            for limit, score in thresholds:
                if change <= limit:
                    return score
            return 0

        us_score = score_from_change(us_change, [(-2.0, 6), (-1.0, 4), (-0.5, 2)])
        il_score = score_from_change(il_change, [(-2.5, 6), (-1.2, 4), (-0.6, 2)])
        btc_score = score_from_change(btc_change, [(-6.0, 8), (-3.0, 6), (-1.5, 4), (-0.7, 2)])
        eth_score = score_from_change(eth_change, [(-7.0, 7), (-4.0, 5), (-2.0, 3), (-1.0, 2)])
        markets_contrib = float(min(15, us_score + il_score + btc_score + eth_score))
    except Exception:
        markets_contrib = 0.0

    # 5) News contribution (0..30) matches the frontend formula
    articles_n = int(news_intel.get("total_count") or 0)
    alerts_n = int(news_intel.get("alert_count") or 0)
    news_contrib = 2.0
    if articles_n <= 3:
        news_contrib = 3 + articles_n * 2 + alerts_n * 1
    elif articles_n <= 6:
        news_contrib = 9 + (articles_n - 3) * 1.5 + alerts_n * 1.5
    elif articles_n <= 10:
        news_contrib = 13.5 + (articles_n - 6) * 1 + alerts_n * 2
    else:
        news_contrib = 17.5 + (articles_n - 10) * 0.5 + alerts_n * 2
    news_contrib = float(min(30, news_contrib))

    # Polymarket (fetch live via public API; fallback to existing)
    polymarket = fetch_polymarket_signal()
    if isinstance(existing.get("polymarket"), dict) and (not isinstance(polymarket, dict) or polymarket.get("market") in ("Polymarket unavailable",)):
        # If live fetch fails, keep the last known market snapshot to avoid flapping to 0.
        polymarket = existing.get("polymarket")
    if not isinstance(polymarket, dict):
        polymarket = {
            "odds": 0,
            "market": "Polymarket unavailable",
            "url": "https://polymarket.com/",
            "timestamp": utc_iso(),
        }
    odds = float(polymarket.get("odds") or 0)
    # Sanity cap
    if odds > 95:
        odds = 0
        polymarket["odds"] = 0
    if odds < 0:
        odds = 0
        polymarket["odds"] = 0
    if not polymarket.get("timestamp"):
        polymarket["timestamp"] = utc_iso()
    if not polymarket.get("url"):
        polymarket["url"] = "https://polymarket.com/"
    if not polymarket.get("market"):
        polymarket["market"] = "No active Iran-related market matched"
    polymarket_contrib = float(min(10, odds * 0.1)) if odds > 0 else 1.0

    # Airspace contribution: airspace.score is a 0..50 raw severity score.
    # Convert to a 0..15 contribution (50 -> 15).
    airspace_raw = float(airspace.get("score") or 0)
    airspace_contrib = float(min(15.0, max(0.0, airspace_raw * 0.3)))

    # Pentagon contribution (frontend mapping)
    raw_p = float((pentagon.get("score") or 30))
    if raw_p < 40:
        pentagon_contrib = 1.0
    elif raw_p <= 60:
        pentagon_contrib = 1 + (raw_p - 40) * 0.1
    elif raw_p <= 80:
        pentagon_contrib = 3 + (raw_p - 60) * 0.2
    else:
        pentagon_contrib = 7 + (raw_p - 80) * 0.15
    pentagon_contrib = float(min(10, pentagon_contrib))

    interest_contrib = float(min(20.0, float(interest.get("interest") or 0)))
    aviation_contrib = float(min(15.0, float(aviation.get("aviation") or 0)))
    military_contrib = float(min(15.0, float(military.get("military") or 0)))
    maritime_contrib = float(min(12.0, float(maritime_ntm.get("score") or 0)))
    weather_contrib = float(min(5.0, float(weather.get("weather") or 0)))
    gps_contrib = float(min(8.0, float((osint.get("gps") or {}).get("contribution") or 0.5)))
    dip_contrib = float(min(12.0, float((osint.get("diplomats") or {}).get("contribution") or 0.5)))

    base_total = (
        news_contrib
        + interest_contrib
        + aviation_contrib
        + maritime_contrib
        + military_contrib
        + markets_contrib
        + polymarket_contrib
        + airspace_contrib
        + pentagon_contrib
        + weather_contrib
        + gps_contrib
        + dip_contrib
    )

    elevated = sum(
        1
        for ok in [
            news_contrib > 10,
            interest_contrib > 8,
            aviation_contrib > 10,
            maritime_contrib > 4,
            military_contrib > 6,
            markets_contrib > 5,
            airspace_contrib > 5,
            pentagon_contrib > 5,
            gps_contrib > 3,
            dip_contrib > 4,
        ]
        if ok
    )
    if elevated >= 3:
        base_total = min(100.0, base_total * 1.15)

    base_total = float(max(0.0, min(100.0, round(base_total))))

    # IOC score
    ioc_score = 0.0
    if alerts_n >= 2:
        ioc_score += 2
    elif alerts_n >= 1:
        ioc_score += 1

    if odds >= 55:
        ioc_score += 2
    elif odds >= 30:
        ioc_score += 1

    airspace_score_for_ioc = float(airspace.get("score") or 0)
    if airspace_score_for_ioc >= 40:
        ioc_score += 2
    elif airspace_score_for_ioc >= 20:
        ioc_score += 1

    if aviation_contrib >= 12:
        ioc_score += 2
    elif aviation_contrib >= 8:
        ioc_score += 1

    if military_contrib >= 10:
        ioc_score += 2
    elif military_contrib >= 6:
        ioc_score += 1

    gps_count = int((osint.get("gps") or {}).get("count") or 0)
    gps_crit = int((osint.get("gps") or {}).get("critical") or 0)
    if gps_contrib >= 6 or gps_crit >= 2:
        ioc_score += 2
    elif gps_contrib >= 3 or gps_count >= 1:
        ioc_score += 1

    dip_count = int((osint.get("diplomats") or {}).get("count") or 0)
    dip_crit = int((osint.get("diplomats") or {}).get("critical") or 0)
    if dip_contrib >= 9 or dip_crit >= 1:
        ioc_score += 2
    elif dip_contrib >= 5 or dip_count >= 1:
        ioc_score += 1

    maritime_count = int(maritime_ntm.get("count") or 0)
    maritime_crit = int(maritime_ntm.get("critical") or 0)
    if maritime_contrib >= 9 or maritime_crit >= 1:
        ioc_score += 2
    elif maritime_contrib >= 5 or maritime_count >= 1:
        ioc_score += 1

    # Trend slope from existing history (projected risk values)
    history = existing.get("history") if isinstance(existing.get("history"), list) else []
    now_ms = utc_ms(now)
    cutoff = now_ms - 6 * 60 * 60 * 1000
    points = []
    for h in history:
        if not isinstance(h, dict):
            continue
        try:
            t = int(h.get("timestamp") or 0)
            rsk = float(h.get("risk"))
            if t >= cutoff:
                points.append((t, rsk))
        except Exception:
            continue
    points.sort(key=lambda x: x[0])
    slope_per_hour = 0.0
    if len(points) >= 2:
        first_t, first_r = points[0]
        last_t, last_r = points[-1]
        hours = (last_t - first_t) / (60 * 60 * 1000)
        if hours > 0.25:
            slope_per_hour = (last_r - first_r) / hours

    slope_effect = max(-12.0, min(12.0, slope_per_hour * 8))
    ioc_effect = min(10.0, max(0.0, float(ioc_score) * 1.25))
    projected = float(round(max(0.0, min(100.0, base_total + slope_effect + ioc_effect))))

    # Update history (72h)
    history.append({"timestamp": now_ms, "risk": projected})
    cutoff_72 = now_ms - 72 * 60 * 60 * 1000
    history = [h for h in history if isinstance(h, dict) and int(h.get("timestamp") or 0) > cutoff_72]

    # Update signalHistory (20 points)
    signal_history = existing.get("signalHistory") if isinstance(existing.get("signalHistory"), dict) else {}
    def _push_hist(key, value):
        arr = signal_history.get(key)
        if not isinstance(arr, list):
            arr = []
        arr.append(int(value))
        if len(arr) > 20:
            arr = arr[-20:]
        signal_history[key] = arr

    _push_hist("news", round((news_contrib / 30) * 100))
    _push_hist("social", round((interest_contrib / 20) * 100))
    _push_hist("flight", round((aviation_contrib / 15) * 100))
    _push_hist("maritime", round((maritime_contrib / 12) * 100))
    _push_hist("military", round((military_contrib / 15) * 100))
    _push_hist("markets", round((markets_contrib / 15) * 100))
    _push_hist("polymarket", round(min(100, odds)))
    _push_hist("airspace", round(min(100, float(airspace.get("score") or 0) * 2)))
    _push_hist("weather", round((weather_contrib / 5) * 100))
    _push_hist("gps", round((gps_contrib / 8) * 100))
    _push_hist("diplomats", round((dip_contrib / 12) * 100))
    _push_hist("pentagon", round(min(100, float(pentagon.get("score") or 0))))

    # 6) Aggregate updates (single source of truth for the dashboard)
    unified_data = {
        "timestamp": now_ms,
        "strikeraedar_updated_ms": now_ms,
        "strikeraedar_updated": utc_iso(now),

        "news_intel": news_intel,
        "news": news_contrib,

        "interest": interest_contrib,
        "socialDetail": interest.get("socialDetail") or "Monitoring...",

        "aviation": aviation_contrib,
        "flightDetail": aviation.get("flightDetail") or "Awaiting data...",

        "military": military_contrib,
        "militaryDetail": military.get("militaryDetail") or "Awaiting data...",

        "weather": weather_contrib,
        "weatherCondition": weather.get("weatherCondition") or "Poor",
        "weatherDetail": weather.get("weatherDetail") or "Weather unavailable",
        "weatherFetched": bool(weather.get("weatherFetched") is True),

        "gps": gps_contrib,
        "gpsDetail": (osint.get("gps") or {}).get("detail") or "Awaiting data...",

        "diplomats": dip_contrib,
        "diplomatsDetail": (osint.get("diplomats") or {}).get("detail") or "Awaiting data...",

        "maritime_ntm": maritime_ntm,

        "polymarket": polymarket,

        "airspace": airspace,
        "markets": markets,
        "pentagon": pentagon,

        "risk_now": base_total,
        "risk_projected_8h": projected,
        "history": history,
        "signalHistory": signal_history,
    }

    # Save locally (backup/debug)
    save_data_locally(unified_data)

    merged = write_merged_payload(existing, unified_data)

    if local_cache:
        write_local_cache(merged, local_cache_path)

    if push:
        push_to_npoint(npoint_id, merged)
    
    # Calculate Total Risk for local display (use projected score stored for clients)
    total_risk_score = float(merged.get("risk_projected_8h") or projected)

    print("\n" + "-"*60)
    print(f"FINAL WAR POTENTIAL SCORE (Projected 8h): {total_risk_score:.0f}/100")
    print("-" * 60)
    
    if total_risk_score > 70:
        print("STATUS: CRITICAL / IMMINENT")
    elif total_risk_score > 40:
        print("STATUS: ELEVATED / WARNING")
    else:
        print("STATUS: LOW / WATCHFUL")
    
    print("\n" + "="*60)
    print("NOTE: Data saved to strikeraedar_data.json")
    print("To update the dashboard without breaking client values/history, use the merged payload:")
    print("  - strikeraedar_merged_payload.json")
    if local_cache:
        print(f"Local cache written to: {local_cache_path}")
    if push:
        print(f"Pushed to npoint: https://api.npoint.io/{npoint_id}")
    print("="*60)


def main():
    parser = argparse.ArgumentParser(description="StrikeRaedar Intelligence Module")
    parser.add_argument("--push", action="store_true", help="Push merged payload directly to npoint.io")
    parser.add_argument("--local-cache", action="store_true", help="Write merged payload to a local cache file (for local hosting)")
    parser.add_argument("--local-cache-path", default="frontend/local_cache.json", help="Path for --local-cache (default: frontend/local_cache.json)")
    parser.add_argument("--watch", action="store_true", help="Run continuously on an interval")
    parser.add_argument("--interval-min", type=int, default=30, help="Interval minutes for --watch (default: 30)")
    parser.add_argument("--npoint-id", default=NPOINT_ID, help="Override npoint ID (default: built-in)")
    args = parser.parse_args()

    if args.watch:
        interval = max(1, int(args.interval_min)) * 60
        print(f"Running in watch mode: every {args.interval_min} min (Ctrl+C to stop)")
        try:
            while True:
                run_once(
                    push=args.push,
                    local_cache=args.local_cache,
                    local_cache_path=args.local_cache_path,
                    npoint_id=args.npoint_id,
                )
                time.sleep(interval)
        except KeyboardInterrupt:
            print("\nStopped.")
            return
    else:
        run_once(
            push=args.push,
            local_cache=args.local_cache,
            local_cache_path=args.local_cache_path,
            npoint_id=args.npoint_id,
        )

if __name__ == "__main__":
    main()
