
import requests
import datetime
import json
import os
import sys
import argparse
import time

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
        return None

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
        "timestamp": datetime.datetime.now().isoformat(),
    }

# -----------------------------------------------------------------------------
# NOTAM / Airspace Logic
# -----------------------------------------------------------------------------
def check_airspace_warnings():
    """
    Checks for critical airspace warnings in Tehran (OIIX) and Tel Aviv (LLLL).
    Uses public data sources or known status if direct API is unavailable.
    """
    print("Checking Airspace Warnings (NOTAMs)...")
    
    warnings = []
    score = 0
    
    # Tehran (OIIX)
    tehran_status = 2 # Currently Red/Danger
    if tehran_status == 2:
        warnings.append(f"CRITICAL: {TEHRAN_FIR} (Tehran) is RESTRICTED/PROHIBITED.")
        score += 40
    elif tehran_status == 1:
        warnings.append(f"WARNING: {TEHRAN_FIR} (Tehran) has advisory warnings.")
        score += 20
        
    # Tel Aviv (LLLL)
    tel_aviv_status = 1 # Currently Yellow/Caution
    if tel_aviv_status == 2:
        warnings.append(f"CRITICAL: {TEL_AVIV_FIR} (Tel Aviv) is CLOSED.")
        score += 50 
    elif tel_aviv_status == 1:
        warnings.append(f"NOTICE: {TEL_AVIV_FIR} (Tel Aviv) has caution advisories.")
        score += 10
        
    print(f"  Airspace Score Contribution: {score}")
    for w in warnings:
        print(f"  - {w}")
        
    return {
        "score": score,
        "details": warnings,
        "status": "Restricted" if score > 30 else "Caution" if score > 0 else "Normal",
        "timestamp": datetime.datetime.now().isoformat()
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
        "timestamp": datetime.datetime.now().isoformat()
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
        "timestamp": datetime.datetime.now().isoformat(),
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

    # Ensure dashboard-friendly timestamp (ms since epoch)
    merged["timestamp"] = int(datetime.datetime.now().timestamp() * 1000)

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
    print("="*60)
    print(f"StrikeRaedar Intelligence Module - {datetime.datetime.now().isoformat()}")
    print("="*60)
    
    # 1. Airspace (NOTAMs)
    airspace = check_airspace_warnings()
    
    # 2. Markets
    markets = check_market_status()
    
    # 3. Pentagon Pizza (Integrated)
    pentagon = get_pentagon_pizza_score()
    
    # 4. Aggregate Data
    unified_data = {
        "airspace": airspace,
        "markets": markets,
        "pentagon": pentagon,
        # NOTE: dashboard expects numeric ms timestamps in many places
        "timestamp": int(datetime.datetime.now().timestamp() * 1000),
    }
    
    # Save locally (backup/debug)
    save_data_locally(unified_data)

    # Merge with existing npoint cache so we don't wipe history/news_intel/etc.
    print("\nMerging with existing npoint cache (prevents overwriting dashboard data)...")
    existing = fetch_existing_npoint(npoint_id)

    # Derive Maritime NtM (Hormuz) from cached news batch when available
    maritime_ntm = compute_maritime_ntm_from_articles((existing.get("news_intel") or {}).get("articles"))
    if maritime_ntm is None:
        # Preserve prior value if we can't derive a fresh one (e.g., cache missing news_intel)
        if isinstance(existing.get("maritime_ntm"), dict):
            maritime_ntm = existing.get("maritime_ntm")
        else:
            maritime_ntm = {
                "score": 0.0,
                "count": 0,
                "critical": 0,
                "detail": "Awaiting data...",
                "samples": [],
                "timestamp": datetime.datetime.now().isoformat(),
            }
    unified_data["maritime_ntm"] = maritime_ntm

    merged = write_merged_payload(existing, unified_data)

    if local_cache:
        write_local_cache(merged, local_cache_path)

    if push:
        push_to_npoint(npoint_id, merged)
    
    # Calculate Total Risk for local display
    total_risk_score = airspace['score'] + markets['score'] + (pentagon['score'] * 0.1)
    
    print("\n" + "-"*60)
    print(f"FINAL WAR POTENTIAL SCORE: {total_risk_score:.0f}/100")
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
