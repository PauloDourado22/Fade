import { db } from '../db/index.js';
import { getSetting } from './settingsService.js';

// Slot granularity is now a runtime setting (Settings > Booking policy),
// defaulting to 60 (on-the-hour). Working hours themselves live in
// working_hours rows; this only controls the step slots are offered at
// within those hours.

/**
 * Marks any pending_payment appointment whose hold has expired as 'expired',
 * freeing the slot back up. Called at the top of every read path that needs
 * an accurate picture of what's actually busy (availability calculation,
 * dashboard list) instead of running a separate cron job — simpler
 * operationally, and correctness doesn't depend on a background process
 * actually being alive.
 */
export function expireStaleHolds() {
  db.prepare(
    `UPDATE appointments
     SET status = 'expired'
     WHERE status = 'pending_payment' AND hold_expires_at < datetime('now')`
  ).run();
}

/**
 * Returns available start times (ISO strings) for a given staff member, date,
 * and service duration.
 *
 * Algorithm: take the staff's working windows for that weekday, subtract
 * every busy interval (confirmed appointments + still-live pending holds),
 * then walk the remaining time in SLOT_STEP_MINUTES increments, keeping any
 * candidate whose [start, start+duration) doesn't collide with a busy
 * interval and doesn't run past the end of the working window.
 */
export function getAvailableSlots({ staffId, date, durationMinutes }) {
  expireStaleHolds();

  // A one-off closure (holiday, private event) overrides the weekly pattern:
  // no slots that day even if the barber normally works it.
  const closed = db.prepare('SELECT 1 FROM closures WHERE date = ?').get(date);
  if (closed) return [];

  const slotStep = getSetting('slot_step_minutes');

  const weekday = new Date(`${date}T00:00:00`).getDay();
  const windows = db
    .prepare('SELECT start_minute, end_minute FROM working_hours WHERE staff_id = ? AND weekday = ?')
    .all(staffId, weekday);

  if (windows.length === 0) return [];

  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(`${date}T23:59:59`);

  const busy = db
    .prepare(
      `SELECT start_at, end_at FROM appointments
       WHERE staff_id = ?
         AND status IN ('confirmed', 'pending_payment')
         AND start_at < ? AND end_at > ?`
    )
    .all(staffId, dayEnd.toISOString(), dayStart.toISOString())
    .map((row) => ({ start: new Date(row.start_at), end: new Date(row.end_at) }));

  const slots = [];
  for (const window of windows) {
    const windowStart = addMinutes(dayStart, window.start_minute);
    const windowEnd = addMinutes(dayStart, window.end_minute);

    for (
      let candidate = windowStart;
      addMinutes(candidate, durationMinutes) <= windowEnd;
      candidate = addMinutes(candidate, slotStep)
    ) {
      const candidateEnd = addMinutes(candidate, durationMinutes);

      // Don't offer slots that have already passed today.
      if (candidate < new Date()) continue;

      const overlaps = busy.some((b) => candidate < b.end && candidateEnd > b.start);
      if (!overlaps) slots.push(candidate.toISOString());
    }
  }

  return slots;
}

/**
 * "First free chair" availability: the union of every active barber's open
 * slots for a date. A slot time is offered if AT LEAST ONE barber can take
 * it - the specific barber is resolved later, at booking time
 * (see bookingService.pickAvailableStaffId). Deduped and sorted so the
 * customer sees one clean list of times regardless of how many barbers
 * happen to be free at each.
 */
export function getAvailableSlotsForAny({ date, durationMinutes }) {
  const staff = db.prepare('SELECT id FROM staff WHERE active = 1').all();
  const union = new Set();
  for (const s of staff) {
    for (const iso of getAvailableSlots({ staffId: s.id, date, durationMinutes })) {
      union.add(iso);
    }
  }
  return [...union].sort();
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}
