"""Business constants. Money is integer cents. These mirror the constants in js/app.js."""
MIN_STAKE_CENTS = 1000
MAX_STAKE_CENTS = 100000
START_BALANCE_CENTS = 10000
START_TICKETS = 1
DEFAULT_STAKE_CENTS = 1000

# pack prices in cents: bigger packs cost less per item, a retry costs half as much as a ticket
PACKS = {
    "bail": {1: 50, 3: 100, 5: 150},
    "retry": {1: 25, 3: 50, 5: 75},
}
RETRIES_PER_MONTH = 4

SECOND = 1000
MINUTE = 60 * SECOND
HOUR = 60 * MINUTE
DAY = 24 * HOUR

OFFER_MS = 10 * MINUTE            # how long a "one more try" offer stays open, counted from the deadline
MIN_LEAD_MS = 5 * MINUTE
MAX_LEAD_MS = 365 * DAY
MAX_NAME = 40

TOPUP_AMOUNTS_CENTS = (2500, 5000, 10000)
TOPUP_DAILY_CAP_CENTS = 50000

MAX_PROOF_ATTEMPTS_PER_TASK = 8
PROOF_PER_HOUR = 30


def default_retry_ms(duration_ms: int) -> int:
    """Same length as the original, kept between 15 minutes and 7 days."""
    return min(7 * DAY, max(15 * MINUTE, duration_ms))


def retry_choices(duration_ms: int) -> list:
    return sorted({default_retry_ms(duration_ms), HOUR, 4 * HOUR, DAY})
