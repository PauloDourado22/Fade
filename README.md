# Fade.

An appointment booking system for barbershops — pick a service, pick a barber (or "first free chair"), pay a deposit through Stripe, get a confirmation code you can use to reschedule or cancel yourself. Plus an owner dashboard for walk-ins, time blocks, and daily stats.

Built to mirror what a real freelance client for this kind of business actually asks for: no double-booked chairs, and a deposit that's genuinely collected — not just recorded — before a slot counts as taken.

The part I'd point to in an interview is how double-booking is prevented: every booking, reschedule, and owner-side slot creation runs a check-then-insert inside a single SQLite transaction, so two people (or the owner and a customer) can't both grab the same chair in the same window. And appointments are only ever confirmed from Stripe's own webhook, verified by signature — never from the browser redirect — so a closed tab or a flaky network can't fake a paid booking.

## Stack

- **Backend:** Express, SQLite (better-sqlite3), Stripe Checkout + webhooks, JWT auth for the owner dashboard
- **Frontend:** Next.js (App Router)

## Running locally

```bash
# backend
cd backend
cp .env.example .env
npm install
npm run seed
npm run dev        # http://localhost:4100

# frontend
cd frontend
cp .env.local.example .env.local
npm install
npm run dev         # http://localhost:3100
```

Set `DEPOSIT_ENABLED=false` in the backend `.env` to test bookings, availability, and the dashboard without configuring real Stripe test keys — double-booking protection still applies either way.
