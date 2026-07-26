import { Router } from 'express';
import { db } from '../db/index.js';
import { getAvailableSlots, getAvailableSlotsForAny } from '../services/availability.js';
import {
  createHoldWithCheckout,
  getAppointmentByPublicCode,
  rescheduleAppointment,
  cancelAppointmentByPublicCode,
  ConflictError,
  NotFoundError,
} from '../services/bookingService.js';
import { getSetting } from '../services/settingsService.js';
import { isValidEmail, isNonEmptyString, isIsoDateString, isPositiveInteger } from '../utils/validate.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

export const publicRouter = Router();

// The customer-relevant slice of settings, so the booking page can honour
// the owner's booking window / deposit / cancellation policy. Deliberately
// NOT the whole settings object - internal values (hold duration, slot step,
// timezone) aren't the customer's business and stay behind the admin auth.
publicRouter.get('/settings', (req, res) => {
  res.json({
    bookingWindowDays: getSetting('booking_window_days'),
    cancellationWindowHours: getSetting('cancellation_window_hours'),
    depositEnabled: getSetting('deposit_enabled'),
  });
});

publicRouter.get('/services', (req, res) => {
  const services = db.prepare("SELECT * FROM services WHERE active = 1 AND name != '__block__' ORDER BY name").all();
  res.json(services);
});

publicRouter.get('/staff', (req, res) => {
  const staff = db.prepare('SELECT id, name, bio FROM staff WHERE active = 1 ORDER BY name').all();
  res.json(staff);
});

publicRouter.get('/availability', (req, res) => {
  const rawStaff = req.query.staffId; // a numeric id, or the literal 'any'
  const date = req.query.date; // 'YYYY-MM-DD'
  const durationMinutes = Number(req.query.durationMinutes);

  if (!isPositiveInteger(durationMinutes) || typeof date !== 'string') {
    return res.status(400).json({ error: 'staffId, date, and durationMinutes are required.' });
  }

  // 'any' = first free chair: return the union of every barber's open slots.
  if (rawStaff === 'any') {
    return res.json({ slots: getAvailableSlotsForAny({ date, durationMinutes }) });
  }

  const staffId = Number(rawStaff);
  if (!isPositiveInteger(staffId)) {
    return res.status(400).json({ error: 'staffId, date, and durationMinutes are required.' });
  }

  const slots = getAvailableSlots({ staffId, date, durationMinutes });
  res.json({ slots });
});

// A booking attempt is the highest-value target for the rate limiter — see
// middleware/rateLimit.js for why (hold griefing).
const bookingLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 8 });

publicRouter.post('/appointments', bookingLimiter, async (req, res, next) => {
  const { serviceId, staffId, startAt, customer } = req.body ?? {};

  // staffId may be a real id or the literal 'any' (first free chair).
  const staffOk = staffId === 'any' || isPositiveInteger(staffId);
  if (
    !isPositiveInteger(serviceId) ||
    !staffOk ||
    !isIsoDateString(startAt) ||
    !customer ||
    !isNonEmptyString(customer.name, 100) ||
    !isValidEmail(customer.email)
  ) {
    return res.status(400).json({ error: 'serviceId, staffId, startAt, and customer{name,email} are required.' });
  }

  try {
    const { appointment, checkoutUrl } = await createHoldWithCheckout({
      serviceId,
      staffId,
      startAt,
      customer,
    });
    res.status(201).json({
      publicCode: appointment.public_code,
      checkoutUrl,
    });
  } catch (err) {
    if (err instanceof ConflictError || err instanceof NotFoundError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

publicRouter.get('/appointments/status', (req, res) => {
  const code = req.query.code;
  if (typeof code !== 'string' || code.length < 6) {
    return res.status(400).json({ error: 'A valid confirmation code is required.' });
  }

  const appointment = getAppointmentByPublicCode(code);
  if (!appointment) {
    return res.status(404).json({ error: 'No appointment found for that code.' });
  }

  // Deliberately return only what a customer needs to see their own
  // confirmation — not the full row (no internal ids beyond the names below,
  // no other customers' data reachable from here since lookup is by
  // unguessable code). staffName/serviceName are the same two fields the
  // /manage endpoint already exposes for this same code — no new surface,
  // just enough for the confirmation screen to read "Rui · Skin Fade · ...".
  const service = db.prepare('SELECT name FROM services WHERE id = ?').get(appointment.service_id);
  const staff = db.prepare('SELECT name FROM staff WHERE id = ?').get(appointment.staff_id);

  res.json({
    status: appointment.status,
    startAt: appointment.start_at,
    customerName: appointment.customer_name,
    staffName: staff?.name,
    serviceName: service?.name,
  });
});

// Same rate limiter shape as bookingLimiter above, on its own instance: an
// unauthenticated write endpoint (even one gated by an unguessable code) is
// still a hold-griefing / abuse vector on IP alone, since the limiter runs
// before the code is even checked. See docs/adr/0002, decision 5.
const manageLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 12 });

// Everything a customer needs to see their own booking to manage it -
// deliberately the same "return only what's needed" shape as /status above,
// plus the fields the manage page's reschedule UI needs (service duration,
// staff id) to fetch fresh availability.
publicRouter.get('/appointments/:code/manage', manageLimiter, (req, res) => {
  const { code } = req.params;
  const appointment = getAppointmentByPublicCode(code);
  if (!appointment) return res.status(404).json({ error: 'No appointment found for that code.' });

  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(appointment.service_id);
  const staff = db.prepare('SELECT id, name FROM staff WHERE id = ?').get(appointment.staff_id);

  res.json({
    status: appointment.status,
    startAt: appointment.start_at,
    customerName: appointment.customer_name,
    serviceName: service?.name,
    depositCents: appointment.deposit_cents,
    priceCents: service?.price_cents,
    durationMinutes: service?.duration_minutes,
    staffId: staff?.id,
    staffName: staff?.name,
  });
});

publicRouter.post('/appointments/:code/reschedule', manageLimiter, (req, res, next) => {
  const { code } = req.params;
  const { startAt } = req.body ?? {};

  if (!isIsoDateString(startAt)) {
    return res.status(400).json({ error: 'A valid startAt is required.' });
  }

  try {
    const appointment = rescheduleAppointment({ publicCode: code, newStartAt: startAt });
    res.json({ status: appointment.status, startAt: appointment.start_at });
  } catch (err) {
    if (err instanceof ConflictError || err instanceof NotFoundError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

publicRouter.post('/appointments/:code/cancel', manageLimiter, (req, res, next) => {
  const { code } = req.params;

  try {
    const appointment = cancelAppointmentByPublicCode(code);
    res.json({ status: appointment.status });
  } catch (err) {
    if (err instanceof ConflictError || err instanceof NotFoundError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});
