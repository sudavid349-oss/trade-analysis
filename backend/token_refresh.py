"""
Auto Token Refresh — runs every day at 8:30 AM IST
Uses Dhan's RenewToken API to get a fresh token before market opens.
Updates .env file automatically so backend always has a valid token.

Two modes:
1. TOTP mode  — fully automatic (needs TOTP secret)
2. RenewToken — semi-automatic (renews existing token, no login needed)
"""
import asyncio
import os
import requests
from datetime import datetime, time, timedelta, timezone
from dotenv import load_dotenv, set_key

# Path to .env file
ENV_PATH = os.path.join(os.path.dirname(__file__), '..', '.env')

IST       = timezone(timedelta(hours=5, minutes=30))
RENEW_TIME = time(8, 30)   # 8:30 AM IST — 45 min before market open


def _seconds_until(target: time) -> float:
    now = datetime.now(IST)
    t   = datetime.combine(now.date(), target, tzinfo=IST)
    if t <= now:
        t += timedelta(days=1)
    return (t - now).total_seconds()


def renew_token(client_id: str, access_token: str) -> str | None:
    """
    Call Dhan RenewToken API.
    Returns new token string or None if failed.
    """
    try:
        resp = requests.post(
            "https://api.dhan.co/v2/RenewToken",
            headers={
                "access-token": access_token,
                "dhanClientId": client_id,
                "Content-Type": "application/json",
            },
            timeout=10,
        )
        data = resp.json()
        new_token = data.get("accessToken")
        if new_token:
            print(f"[TokenRefresh] ✅ Token renewed successfully. Expires: {data.get('expiryTime')}")
            return new_token
        else:
            print(f"[TokenRefresh] ❌ Renewal failed: {data}")
            return None
    except Exception as e:
        print(f"[TokenRefresh] ❌ Error: {e}")
        return None


def update_env(new_token: str):
    """Update DHAN_ACCESS_TOKEN in .env file."""
    set_key(ENV_PATH, "DHAN_ACCESS_TOKEN", new_token)
    print(f"[TokenRefresh] .env updated with new token")


async def token_refresh_loop():
    """Runs forever — renews token every day at 8:30 AM IST."""
    print("[TokenRefresh] Auto token refresh scheduler started")

    while True:
        wait = _seconds_until(RENEW_TIME)
        next_run = datetime.now(IST) + timedelta(seconds=wait)
        print(f"[TokenRefresh] Next renewal at {next_run.strftime('%Y-%m-%d %H:%M IST')}")
        await asyncio.sleep(wait)

        # Skip weekends
        today = datetime.now(IST).weekday()
        if today >= 5:  # Saturday=5, Sunday=6
            print("[TokenRefresh] Weekend — skipping renewal")
            continue

        # Load current credentials
        load_dotenv(ENV_PATH, override=True)
        client_id    = os.getenv("DHAN_CLIENT_ID")
        access_token = os.getenv("DHAN_ACCESS_TOKEN")

        if not client_id or not access_token:
            print("[TokenRefresh] ❌ Credentials not found in .env")
            continue

        # Try to renew
        new_token = renew_token(client_id, access_token)
        if new_token:
            update_env(new_token)
            # Also update environment variable in current process
            os.environ["DHAN_ACCESS_TOKEN"] = new_token
        else:
            print("[TokenRefresh] ⚠️ Could not auto-renew. Token may expire today.")
            print("[TokenRefresh] Please manually update token at web.dhanhq.co")


if __name__ == "__main__":
    # Can also run standalone for testing
    asyncio.run(token_refresh_loop())
