"""Settles missed deadlines on a timer, so stakes are forfeited on time even if the user never opens the app.

    python -m backend.worker          # every 60 seconds
    python -m backend.worker --once   # one pass (cron)
"""
import sys
import time

from . import clock, create_app
from .models import db
from .services import tasks


def settle_due():
    changed = tasks.settle(clock.now_ms())
    db.session.commit()
    return changed


def main(argv):
    app = create_app()
    with app.app_context():
        while True:
            try:
                n = settle_due()
                if n:
                    app.logger.info("settled %s task(s)", n)
            except Exception:
                db.session.rollback()
                app.logger.exception("settle failed")
            if "--once" in argv:
                return
            time.sleep(60)


if __name__ == "__main__":
    main(sys.argv[1:])
