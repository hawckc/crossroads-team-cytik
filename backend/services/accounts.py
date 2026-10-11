"""Users: registration rules (same as validateRegistration in js/app.js) and the monthly free-retry allowance."""
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from werkzeug.security import check_password_hash, generate_password_hash

from .. import rules
from ..models import User, db
from . import activity, ledger

USERNAME_RE = re.compile(r"^[a-z0-9._-]{2,20}$")


def validate_registration(data):
    """Returns {field: message}; empty means valid. Does not check whether the username is taken."""
    errors = {}
    name = str(data.get("name") or "").strip()
    username = str(data.get("username") or "").strip().lower()
    password = str(data.get("password") or "")
    if not name:
        errors["name"] = "Enter your name"
    elif len(name) > 30:
        errors["name"] = "30 characters or fewer"
    if not username:
        errors["username"] = "Choose a username"
    elif not USERNAME_RE.match(username):
        errors["username"] = "2 to 20 letters or numbers"
    if len(password) < 6:
        errors["password"] = "At least 6 characters"
    elif len(password) > 200:
        errors["password"] = "Too long"
    elif password.lower() == username:
        errors["password"] = "Cannot match your username"
    return errors


def clean_timezone(tz):
    try:
        ZoneInfo(str(tz))
        return str(tz)
    except Exception:
        return "UTC"


def find(username):
    return db.session.scalar(select(User).where(User.username == str(username).strip().lower()))


def create_user(username, name, password, tz, now, demo=False):
    """A new account with $100 and one bail-out ticket, like freshState() in js/mock-data.js."""
    user = User(
        username=username.strip().lower(), name=name.strip(), password_hash=generate_password_hash(password),
        timezone=clean_timezone(tz), tickets=rules.START_TICKETS, default_stake_cents=rules.DEFAULT_STAKE_CENTS,
        is_demo=demo, onboarded=demo, created_at=now,
    )
    db.session.add(user)
    db.session.flush()
    ledger.transfer(ledger.account(ledger.TOPUP), ledger.account(ledger.WALLET, user.id), rules.START_BALANCE_CENTS, f"fund:{user.id}", now=now)
    activity.add(user.id, "funds", "💰", f"Account funded with {activity.fmt(rules.START_BALANCE_CENTS)}", now)
    return user


def check_password(user, password):
    return check_password_hash(user.password_hash, password)


def month_key(user, now):
    return datetime.fromtimestamp(now / 1000, tz=timezone.utc).astimezone(ZoneInfo(user.timezone)).strftime("%Y-%m")


def free_retries_left(user, now):
    used = user.retries_used if user.retries_month == month_key(user, now) else 0
    return max(0, rules.RETRIES_PER_MONTH - used)


def retries_left(user, now):
    return free_retries_left(user, now) + user.extra_retries


def use_retry(user, now):
    """Free retries go first, so bought ones last."""
    mk = month_key(user, now)
    if user.retries_month != mk:
        user.retries_month, user.retries_used = mk, 0
    if user.retries_used < rules.RETRIES_PER_MONTH:
        user.retries_used += 1
    else:
        user.extra_retries -= 1
