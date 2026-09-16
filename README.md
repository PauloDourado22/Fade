# Barbershop Booking 

An appointment booking system: customers pick a service, barber, and time
slot, pay a deposit through Stripe, and the shop owner manages everything
from a small dashboard. This is the "Stripe ecommerce/booking" service
package rebuilt in React/Next.js + Node — the deliberately most ambitious of
the three new portfolio projects.

**Live pitch for a client:** "I can build you a booking system that takes
deposits automatically and can't be double-booked — no more phone tag."

## Why this is the flagship, not just another CRUD app

Three things here are the kind of detail that separates "I followed a
tutorial" from "I understand what can go wrong in production":

1. **Double-booking is actually prevented, not just discouraged.**
   `backend/src/services/bookingService.js` wraps the "check for a
   conflicting appointment, then insert" logic in a single SQLite
   transaction. Combined with better-sqlite3 being synchronous, this closes
   the classic race condition where two customers both see a slot as free
   and both submit at once.

2. **Payment confirmation is driven by the Stripe webhook, not the browser
   redirect.** `backend/src/routes/webhooks.js` verifies Stripe's signature
   and is the *only* thing that marks an appointment `confirmed`. The
   `success_url` redirect is just UX — a closed tab or flaky network can't
   fake a paid booking, because nothing trusts the client's word for it.

3. **Abandoned holds don't lock a slot forever, and abuse is rate-limited.**
   A booking hold expires after `HOLD_DURATION_MINUTES` (see
   `backend/src/services/availability.js`); the booking endpoint is also
   rate-limited per IP against "hold griefing" — someone repeatedly starting
   but never completing checkout to deny other customers a slot.

## Architecture

```
frontend (Next.js)                backend (Express)              external
  /            marketing page  →     /api/public/*      →   (no external calls
  /book        booking flow     →    /api/appointments   →    besides Stripe)
  /login       owner auth       →    /api/auth
  /dashboard   owner view       →                        ←   Stripe webhook
                                                               (payment confirmed)
                                  SQLite (better-sqlite3, WAL mode)
```

## Security notes (worth reading even if you skip the rest)

- **Public appointment lookups use an unguessable `public_code`, never the
  database's integer ID.** Sequential IDs would let anyone enumerate other
  customers' bookings by changing a number in the URL.
- **Stripe webhook signature verification is mandatory** — without it,
  anyone could POST a fake "payment succeeded" event and get a free booking.
- **Passwords are hashed with bcrypt (12 rounds)**, and login returns the
  same error for "no such user" and "wrong password" to avoid leaking which
  emails have accounts.
- **CORS is locked to the configured frontend origin**, not left open.
- **The dashboard JWT lives in `localStorage`**, not an httpOnly cookie —
  documented as a conscious trade-off in `backend/src/middleware/auth.js`,
  not an oversight.

## Running it locally

```bash
# backend
cd backend
cp .env.example .env          # then fill in JWT_SECRET and Stripe test keys
npm install
npm run seed                   # creates the owner login + sample staff/services
npm run dev                    # http://localhost:4100

# Stripe webhook, in a second terminal (requires the Stripe CLI):
stripe listen --forward-to localhost:4100/api/webhooks/stripe
# copy the printed whsec_... into backend/.env as STRIPE_WEBHOOK_SECRET

# frontend, in a third terminal
cd frontend
cp .env.local.example .env.local
npm install
npm run dev                    # http://localhost:3100
```

Seeded owner login: `owner@example.com` / `change-me-please` — change this
before showing the project to anyone.

Test the booking flow with Stripe's test card `4242 4242 4242 4242`, any
future expiry, any CVC.

## Deploying

- **Backend:** Render/Railway (Node service) — mount a persistent disk for
  the SQLite file, or migrate to Postgres for a proper multi-instance deploy.
- **Frontend:** Vercel.
- Register the production webhook URL in the Stripe dashboard once deployed.

## What a v2 would add

- Multi-tenant support (multiple shops, not just one) — the schema was kept
  single-tenant on purpose to keep this scoped; every table would need a
  `shop_id` column and every query a matching `WHERE shop_id = ?`.
- Email confirmations/reminders (e.g. via Resend or Postmark).
- Move from `localStorage` JWTs to httpOnly cookies once there's a reason to
  (e.g. adding third-party scripts that increase XSS surface).
- Swap SQLite for Postgres if this needs to run on more than one instance.

