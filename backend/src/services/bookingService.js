import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { getSetting } from './settingsService.js';
import { createCheckoutSession } from './stripeService.js';

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.status = 409;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.status = 404;
  }
}

/**
 * The one place double-booking gets prevented. `db.transaction` wraps the
 * check-then-insert in a single SQLite transaction — combined with
 * better-sqlite3 being synchronous (no other request's code can run in
 * between our check and our insert on Node's single thread), this closes the
 * classic race condition where two people both see a slot as "free" and both
 * book it. This is the detail interviewers ask about when they say "tell me
 * about a tricky bug or edge case you handled."
 */
export function createBookingHold({ serviceId, staffId, startAt, customer }) {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(serviceId);
  if (!service) throw new NotFoundError('Service not found.');

  // staffId 'any' = "first free chair": the customer didn't pick a barber,
  // so one is resolved inside the transaction below. For a specific pick we
  // validate it exists up front, same as before.
  const isAny = staffId === 'any';
  if (!isAny) {
    const staff = db.prepare('SELECT * FROM staff WHERE id = ? AND active = 1').get(staffId);
    if (!staff) throw new NotFoundError('Staff member not found.');
  }

  const start = new Date(startAt);
  const end = new Date(start.getTime() + service.duration_minutes * 60_000);
  const holdExpiresAt = new Date(Date.now() + getSetting('hold_duration_minutes') * 60_000);
  const publicCode = nanoid(12);

  const insert = db.transaction(() => {
    // Resolve "any" to a concrete barber *inside* the transaction, so the
    // pick and the conflict check that follows are atomic - two concurrent
    // "first free chair" bookings can't both grab the same barber.
    const effectiveStaffId = isAny ? pickAvailableStaffId(start, end) : staffId;
    if (isAny && !effectiveStaffId) {
      throw new ConflictError('No barber is free at that time. Please pick another slot.');
    }

    const conflict = db
      .prepare(
        `SELECT id FROM appointments
         WHERE staff_id = ?
           AND status IN ('confirmed', 'pending_payment')
           AND start_at < ? AND end_at > ?`
      )
      .get(effectiveStaffId, end.toISOString(), start.toISOString());

    if (conflict) {
      throw new ConflictError('That slot was just taken. Please pick another time.');
    }

    const result = db
      .prepare(
        `INSERT INTO appointments
           (public_code, service_id, staff_id, customer_name, customer_email, customer_phone,
            start_at, end_at, status, hold_expires_at, deposit_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?)`
      )
      .run(
        publicCode,
        serviceId,
        effectiveStaffId,
        customer.name,
        customer.email,
        customer.phone ?? null,
        start.toISOString(),
        end.toISOString(),
        holdExpiresAt.toISOString(),
        service.deposit_cents
      );

    return db.prepare('SELECT * FROM appointments WHERE id = ?').get(result.lastInsertRowid);
  });

  const appointment = insert();
  return { appointment, service };
}

/**
 * Picks the first active barber who both works the requested window and has
 * no conflicting appointment in it - the "first free chair" resolver. Ordered
 * by id for deterministic assignment; a fairness/load-balancing order could
 * replace that later without changing callers. Returns null if nobody is free.
 * Called only inside createBookingHold's transaction.
 */
function pickAvailableStaffId(start, end) {
  const weekday = start.getDay();
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getHours() * 60 + end.getMinutes();

  const staff = db.prepare('SELECT id FROM staff WHERE active = 1 ORDER BY id').all();
  for (const s of staff) {
    const worksWindow = db
      .prepare(
        `SELECT 1 FROM working_hours
         WHERE staff_id = ? AND weekday = ? AND start_minute <= ? AND end_minute >= ?`
      )
      .get(s.id, weekday, startMin, endMin);
    if (!worksWindow) continue;

    const conflict = db
      .prepare(
        `SELECT 1 FROM appointments
         WHERE staff_id = ?
           AND status IN ('confirmed', 'pending_payment')
           AND start_at < ? AND end_at > ?`
      )
      .get(s.id, end.toISOString(), start.toISOString());
    if (!conflict) return s.id;
  }
  return null;
}

export async function createHoldWithCheckout(input) {
  const { appointment, service } = createBookingHold(input);

  // Test-only bypass (see config.js's depositEnabled comment). Skips Stripe
  // entirely and confirms the appointment immediately - the double-booking
  // conflict check already ran inside createBookingHold above, so this only
  // turns off payment collection, not slot-safety. The frontend doesn't
  // need to know this happened: it still gets a `checkoutUrl` and does its
  // normal `window.location.href = checkoutUrl` redirect - it just lands
  // straight on the real confirmation page instead of Stripe Checkout.
  if (!getSetting('deposit_enabled')) {
    db.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ?").run(appointment.id);
    const confirmed = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment.id);
    return {
      appointment: confirmed,
      checkoutUrl: `${config.frontendUrl}/book/confirmation?code=${confirmed.public_code}`,
    };
  }

  const session = await createCheckoutSession({
    appointment,
    service,
    publicCode: appointment.public_code,
  });

  db.prepare('UPDATE appointments SET stripe_session_id = ? WHERE id = ?').run(
    session.id,
    appointment.id
  );

  return { appointment, checkoutUrl: session.url };
}

export function confirmAppointmentByStripeSession(sessionId, paymentIntentId) {
  const appointment = db
    .prepare('SELECT * FROM appointments WHERE stripe_session_id = ?')
    .get(sessionId);

  if (!appointment) {
    console.warn(`Webhook received for unknown session ${sessionId}`);
    return null;
  }

  // Idempotency guard: Stripe can and does retry webhook delivery. Without
  // this check, a retried event would be harmless here (UPDATE is naturally
  // idempotent), but it's cheap insurance and documents the assumption.
  if (appointment.status === 'confirmed') return appointment;

  db.prepare(
    "UPDATE appointments SET status = 'confirmed', stripe_payment_intent_id = ? WHERE id = ?"
  ).run(paymentIntentId, appointment.id);

  return db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment.id);
}

export function getAppointmentByPublicCode(code) {
  return db.prepare('SELECT * FROM appointments WHERE public_code = ?').get(code);
}

// Which statuses a customer-initiated reschedule/cancel is allowed to act
// on - mirrors VALID_TRANSITIONS in routes/appointments.js (the owner-side
// status endpoint): you can't "reschedule" something already completed or
// cancelled.
const RESCHEDULABLE_STATUSES = ['confirmed', 'pending_payment'];

/**
 * Moves a customer's own appointment to a new start time, found by their
 * public_code (see the module doc on createBookingHold for why that's the
 * right identifier for an unauthenticated customer to prove "this is mine").
 *
 * Reuses the exact same check-then-update-inside-a-transaction shape as
 * createBookingHold: a reschedule is a second way to end up with two
 * appointments overlapping the same staff member's time, so it needs the
 * same protection, not a weaker copy of it. The only difference from the
 * original booking's conflict check is `id != ?` — a slot must not conflict
 * with any *other* appointment, but obviously does "conflict" with its own
 * current row.
 */
export function rescheduleAppointment({ publicCode, newStartAt }) {
  const appointment = getAppointmentByPublicCode(publicCode);
  if (!appointment) throw new NotFoundError('No appointment found for that code.');

  if (!RESCHEDULABLE_STATUSES.includes(appointment.status)) {
    throw new ConflictError(`A booking that is "${appointment.status}" can't be rescheduled.`);
  }

  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(appointment.service_id);
  const newStart = new Date(newStartAt);
  const newEnd = new Date(newStart.getTime() + service.duration_minutes * 60_000);

  const update = db.transaction(() => {
    const conflict = db
      .prepare(
        `SELECT id FROM appointments
         WHERE staff_id = ?
           AND id != ?
           AND status IN ('confirmed', 'pending_payment')
           AND start_at < ? AND end_at > ?`
      )
      .get(appointment.staff_id, appointment.id, newEnd.toISOString(), newStart.toISOString());

    if (conflict) {
      throw new ConflictError('That slot was just taken. Please pick another time.');
    }

    db.prepare('UPDATE appointments SET start_at = ?, end_at = ? WHERE id = ?').run(
      newStart.toISOString(),
      newEnd.toISOString(),
      appointment.id
    );

    return db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment.id);
  });

  return update();
}

/**
 * Customer-initiated cancel, found by public_code - the self-service
 * counterpart to the owner-only PATCH /api/appointments/:id/status route.
 */
export function cancelAppointmentByPublicCode(publicCode) {
  const appointment = getAppointmentByPublicCode(publicCode);
  if (!appointment) throw new NotFoundError('No appointment found for that code.');

  if (!RESCHEDULABLE_STATUSES.includes(appointment.status)) {
    throw new ConflictError(`A booking that is "${appointment.status}" can't be cancelled here.`);
  }

  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(appointment.id);
  return db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment.id);
}

// Shared conflict-check-then-insert used by the two owner-side creators
// below. Same transactional guarantee as createBookingHold (see its doc):
// the check and insert run in one better-sqlite3 transaction on a single
// thread, so two owner actions can't both slip into the same slot. Rows go
// in already 'confirmed' - an owner-created entry (walk-in or block) is not
// waiting on a deposit, so it should occupy the chair immediately.
function insertConfirmedRow({ serviceId, staffId, start, end, customerName, customerEmail, depositCents, isBlock }) {
  const publicCode = nanoid(12);

  const insert = db.transaction(() => {
    const conflict = db
      .prepare(
        `SELECT id FROM appointments
         WHERE staff_id = ?
           AND status IN ('confirmed', 'pending_payment')
           AND start_at < ? AND end_at > ?`
      )
      .get(staffId, end.toISOString(), start.toISOString());

    if (conflict) {
      throw new ConflictError('That time overlaps something already on this barber\'s book.');
    }

    const result = db
      .prepare(
        `INSERT INTO appointments
           (public_code, service_id, staff_id, customer_name, customer_email, customer_phone,
            start_at, end_at, status, hold_expires_at, deposit_cents, is_block)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'confirmed', NULL, ?, ?)`
      )
      .run(publicCode, serviceId, staffId, customerName, customerEmail, start.toISOString(), end.toISOString(), depositCents, isBlock);

    return db.prepare('SELECT * FROM appointments WHERE id = ?').get(result.lastInsertRowid);
  });

  return insert();
}

/**
 * Owner-created walk-in: a real customer the owner is booking in person, so
 * it skips the deposit/Stripe flow entirely and lands 'confirmed'. deposit
 * is 0 (they pay the full price at the chair), which is why the dashboard's
 * "deposits secured" doesn't move but "at the chair" does.
 */
export function createOwnerBooking({ serviceId, staffId, startAt, customerName, customerEmail }) {
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(serviceId);
  if (!service) throw new NotFoundError('Service not found.');

  const staff = db.prepare('SELECT * FROM staff WHERE id = ? AND active = 1').get(staffId);
  if (!staff) throw new NotFoundError('Staff member not found.');

  const start = new Date(startAt);
  const end = new Date(start.getTime() + service.duration_minutes * 60_000);

  return insertConfirmedRow({
    serviceId,
    staffId,
    start,
    end,
    customerName,
    customerEmail: customerEmail || '',
    depositCents: 0,
    isBlock: 0,
  });
}

// A block needs a service_id (the column is NOT NULL + a foreign key), but a
// "barber's at lunch" row has no real service. Rather than make service_id
// nullable (a table rebuild), we point every block at one inactive sentinel
// service, created on first use so it never depends on a re-seed. active = 0
// keeps it out of the customer-facing service list.
function getOrCreateBlockServiceId() {
  const existing = db.prepare("SELECT id FROM services WHERE name = '__block__'").get();
  if (existing) return existing.id;
  const result = db
    .prepare(
      "INSERT INTO services (name, duration_minutes, price_cents, deposit_cents, active) VALUES ('__block__', 0, 0, 0, 0)"
    )
    .run();
  return result.lastInsertRowid;
}

/**
 * Owner-created time block: no customer, no real service. Stored as a normal
 * 'confirmed' appointment (so every availability/conflict check treats the
 * chair as busy for free) but flagged is_block = 1 so counts and revenue
 * skip it. The block's reason (e.g. "Lunch") rides in customer_name, which
 * is where the dashboard reads it from for display.
 */
export function createBlock({ staffId, startAt, durationMinutes, reason }) {
  const staff = db.prepare('SELECT * FROM staff WHERE id = ? AND active = 1').get(staffId);
  if (!staff) throw new NotFoundError('Staff member not found.');

  const start = new Date(startAt);
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  return insertConfirmedRow({
    serviceId: getOrCreateBlockServiceId(),
    staffId,
    start,
    end,
    customerName: reason?.trim() || 'Blocked',
    customerEmail: '',
    depositCents: 0,
    isBlock: 1,
  });
}
