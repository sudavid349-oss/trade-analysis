"""
DhanChart Configuration
Set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN in your .env file or environment.
"""
import os
from dotenv import load_dotenv

load_dotenv()

DHAN_CLIENT_ID   = os.getenv("DHAN_CLIENT_ID", "YOUR_CLIENT_ID")
DHAN_ACCESS_TOKEN = os.getenv("DHAN_ACCESS_TOKEN", "YOUR_ACCESS_TOKEN")

DB_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://dhanchart:dhanchart@localhost:5432/dhanchart"
)

# Indian indices — (security_id, exchange_segment, display_name)
INDICES = [
    {"id": "13",  "segment": "IDX_I", "name": "NIFTY 50",   "symbol": "NIFTY"},
    {"id": "25",  "segment": "IDX_I", "name": "BANK NIFTY", "symbol": "BANKNIFTY"},
    {"id": "51",  "segment": "BSE_I", "name": "SENSEX",      "symbol": "SENSEX"},
]

# Dhan MarketFeed exchange segment codes
SEGMENT_MAP = {
    "IDX_I": 13,  # NSE Index
    "BSE_I": 20,  # BSE Index
    "NSE_EQ": 1,
    "NSE_FNO": 2,
}

# Retention policy
TICK_RETENTION_DAYS     = 7
CANDLE_1M_RETENTION_DAYS = 30
OC_SNAPSHOT_RETENTION_DAYS = 7

# Option chain snapshot interval (minutes, during market hours)
OC_SNAPSHOT_INTERVAL_MIN = 5

# ATM strikes to store on each side during live snapshots
OC_LIVE_STRIKES_EACH_SIDE = 20

# Market hours (IST)
MARKET_OPEN  = "09:15"
MARKET_CLOSE = "15:30"
