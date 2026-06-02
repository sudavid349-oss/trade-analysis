"""
Quick test to verify Dhan API credentials and responses.
Run: python test_dhan.py
"""
import os
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', '.env'))

CLIENT_ID    = os.getenv("DHAN_CLIENT_ID")
ACCESS_TOKEN = os.getenv("DHAN_ACCESS_TOKEN")

print(f"Client ID    : {CLIENT_ID}")
print(f"Access Token : {ACCESS_TOKEN[:30]}..." if ACCESS_TOKEN else "Access Token : NOT SET")
print()

if not CLIENT_ID or CLIENT_ID == "YOUR_CLIENT_ID":
    print("❌ .env not set correctly.")
    exit(1)

from dhanhq import DhanContext, dhanhq
from datetime import date, timedelta

ctx  = DhanContext(CLIENT_ID, ACCESS_TOKEN)
dhan = dhanhq(ctx)

from_date = (date.today() - timedelta(days=10)).isoformat()
to_date   = date.today().isoformat()

# Try all known segment + instrument_type combos for NIFTY
combos = [
    ("NSE",   "INDEX"),
    ("NSE",   "FUTIDX"),
    ("IDX_I", "INDEX"),
    ("IDX_I", "FUTIDX"),
]

print("── Test 1: Finding correct params for NIFTY daily ──")
for seg, itype in combos:
    try:
        resp = dhan.historical_daily_data(
            security_id="13",
            exchange_segment=seg,
            instrument_type=itype,
            from_date=from_date,
            to_date=to_date,
        )
        status = resp.get("status")
        data   = resp.get("data")
        closes = data.get("close", []) if isinstance(data, dict) else []
        print(f"  seg={seg:8} type={itype:8} → status={status} candles={len(closes)}")
        if status == "success" and closes:
            print(f"  ✅ WORKING COMBO: segment='{seg}' instrument_type='{itype}'")
            print(f"  Last close: {closes[-1]}")
    except Exception as e:
        print(f"  seg={seg:8} type={itype:8} → ❌ {e}")

print()
print("── Test 2: Finding correct params for NIFTY intraday ──")
for seg, itype in combos:
    try:
        resp = dhan.intraday_minute_data(
            security_id="13",
            exchange_segment=seg,
            instrument_type=itype,
            interval=5,
            from_date=(date.today() - timedelta(days=3)).isoformat(),
            to_date=to_date,
        )
        status = resp.get("status")
        data   = resp.get("data")
        closes = data.get("close", []) if isinstance(data, dict) else []
        print(f"  seg={seg:8} type={itype:8} → status={status} candles={len(closes)}")
        if status == "success" and closes:
            print(f"  ✅ WORKING COMBO: segment='{seg}' instrument_type='{itype}'")
    except Exception as e:
        print(f"  seg={seg:8} type={itype:8} → ❌ {e}")

print()
print("── Test 3: dhanhq library version ──")
import dhanhq
print(f"  dhanhq version: {dhanhq.__version__ if hasattr(dhanhq, '__version__') else 'unknown'}")

