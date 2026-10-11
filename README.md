# Commit.

**Put money on your goals. Miss one, and your stake goes to charity.**

Most of us know what we should be doing. We just don't do it. Commit gives you a reason to follow through: you pick a task, set a deadline, and put a few dollars on it. Finish on time and you keep your money. Miss it and the stake is donated to a charity you chose.

You prove each task with a quick photo, so it's honest, and you can't tick things off from the sofa.

<p align="center">
  <img src="docs/screenshots/today.png" alt="Today screen with a running timer" width="260">
  &nbsp;
  <img src="docs/screenshots/ai-partners.png" alt="AI assistant suggesting partner offers" width="260">
  &nbsp;
  <img src="docs/screenshots/proof-verified.png" alt="Photo proof verified" width="260">
</p>

---

## How it works

1. **Pick a task.** Something small and real: go to the gym, cook dinner, read 20 pages.
2. **Stake some money.** Choose how much it's worth to you, and how long you have.
3. **Do it, and snap a photo.** Take a picture as proof.
4. **Keep your money, or give it away.** Done in time, the stake comes back. Missed, it goes to charity.

---

## Notable features

### 1. AI assistant that helps you find your next goal

Not sure what to commit to? Ask the AI assistant. It's a short, friendly chat that works out what suits you *right now*.

- It asks how you're feeling, where you are, how much time you have, and whether you want more of what you already do or something new.
- It remembers what you've finished before, so suggestions build on your habits (or deliberately steer you away from them).
- It never suggests something you already have running.
- You get three tailored ideas, each with a place to go, a time and a stake, ready to start in one tap.
- It's one tap away from the **New task** screen, and the same kind of suggestions power the short setup new users see when they first sign up.

<p align="center">
  <img src="docs/screenshots/ai-question.png" alt="The AI assistant asking how you feel" width="240">
  &nbsp;
  <img src="docs/screenshots/ai-ideas.png" alt="Three personalised task ideas" width="240">
  &nbsp;
  <img src="docs/screenshots/new-task.png" alt="New task screen with a link to the AI assistant" width="240">
</p>

### 2. Partner offers

Alongside the AI's ideas, you'll see offers from local partners that make it easier to start: a free day pass at a gym, an intro yoga class at a promotional price, a free group run with a shoe fitting, a free audiobook, a discounted first meal box and more. Partners get their own colour and logo and are highlighted so you won't miss them. Claim an offer and it becomes a task, with a code to show when you arrive.

<p align="center">
  <img src="docs/screenshots/ai-partners.png" alt="Highlighted partner offers" width="240">
  &nbsp;
  <img src="docs/screenshots/partner-route.png" alt="Partner offer with a map showing the way" width="240">
</p>

### 3. A map that shows you where to go

Every suggestion that involves going somewhere comes with a small map: you, the place, and the route between. Running tasks show the loop you'd run. Home tasks show where to pick up supplies. Tap **Details** or **Start** to see it.

<p align="center">
  <img src="docs/screenshots/details-map.png" alt="Details with a running route map" width="240">
</p>

### 4. Photo proof, checked by AI

When you're done, you take a photo of the result: the gym floor, the finished plate, your open book. The app checks it looks like the real thing and tells you how confident it is. No honest photo, no completion.

<p align="center">
  <img src="docs/screenshots/camera.png" alt="Taking a proof photo" width="240">
  &nbsp;
  <img src="docs/screenshots/proof-verified.png" alt="Photo verified" width="240">
</p>

### 5. Real stakes, for a good cause

You choose a charity when you start, and misses go straight to it. Each charity shows how much has been raised towards its goal, so a missed task still does some good.

<p align="center">
  <img src="docs/screenshots/charity.png" alt="Charity screen" width="240">
</p>

### 6. A safety net for real life

Life happens, so there are two kinds of ticket in the Shop:

- **Bail-out ticket:** truly blocked? Use one to clear a task. You keep your stake and nothing goes to charity.
- **One more try:** missed a deadline? Get another go. You get a few free every month, and can buy more.

Swipe between the two, or tap either counter to jump to it.

<p align="center">
  <img src="docs/screenshots/shop-bail.png" alt="Bail-out tickets in the shop" width="240">
  &nbsp;
  <img src="docs/screenshots/shop-retry.png" alt="One more try in the shop" width="240">
</p>

### 7. Keep track of your progress

A countdown for every task, and a history of everything you've completed, missed or cleared, with the proof photo for each one you finished.

<p align="center">
  <img src="docs/screenshots/history.png" alt="History of completed and missed tasks" width="240">
</p>

---

## Try it

Open the app and tap **Try the demo** on the sign-in screen. It comes filled with a sample account, some running tasks and a bit of history.

To run it on your computer, start it with `python app.py` and open <http://localhost:5002>. Open `phone.html` to see it inside a phone frame, where the camera is simulated with ready-made photos so you can try the whole proof flow.

### Optional backend (off by default)

The app normally runs entirely in the browser. There is also a Flask backend in `backend/` that keeps accounts, money, tasks and photo checks on a server. Nothing uses it unless you turn it on:

```
pip install -r requirements-backend.txt
COMMIT_BACKEND=1 python app.py       # the API under /api/v1, plus the client
python -m backend.worker             # optional: settles missed deadlines while nobody is online
```

Then open <http://localhost:5002/?api=1>. The choice lasts for that browser tab; `?api=0` (or a new tab) goes back to the in-browser version. The demo account (`demo` / `demo123`) is created automatically. Useful settings:

| Variable | Default | What it does |
| --- | --- | --- |
| `SECRET_KEY` | dev key | Required when `COMMIT_ENV=production` |
| `DATABASE_URL` | `sqlite:///commit.db` (in `instance/`) | Any SQLAlchemy URL, such as PostgreSQL |
| `VERIFIER_PROVIDER` | `mock` | `claude` checks photos with the Anthropic API (needs `ANTHROPIC_API_KEY`) |
| `VERIFIER_MODEL` | `claude-haiku-5-5` | Model used when the provider is `claude` |
| `DUPLICATE_PHOTO_CHECK` | on with `claude`, off with `mock` | Reject a photo that matches an earlier proof. The demo's stock camera photos repeat, so leave it off there |
| `COMMIT_DEMO` | on (off in production) | Create the demo account |
| `HOST`, `PORT`, `FLASK_DEBUG` | `127.0.0.1`, `5002`, off | Dev server; use `HOST=0.0.0.0` to test from a phone |

`pip install -r requirements-dev.txt` then `pytest` runs the backend tests. See [BACKEND-PLAN.md](BACKEND-PLAN.md) for the design.

> **A note on the demo.** This is a prototype. No real money moves, the partners and the maps are made-up samples, and the photo check is simulated. Everything you see is there to show how the finished app would feel.

---

## Photo credits

The sample proof photos come from Wikimedia Commons. Sources are listed in [img/proof/CREDITS.md](img/proof/CREDITS.md)