'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';

// FADE.'s flow leads with "who's cutting" rather than "what service" - see
// docs/adr/0002-fade-rebrand-implementation.md, decision 3.
const STEPS = ['Barber', 'Service', 'Time', 'Lock it in'];

// Per-step headline copy, matched verbatim to the FADE. design direction
// (mockups 4b/5b) rather than paraphrased.
const HEADLINES = ["Who's cutting?", 'What are we doing?', 'When?', 'Lock it in.'];

// Day-strip replaces the native <input type="date"> in the Time step - same
// closed-day assumption already hardcoded in availability.js/seed.js (staff
// only get working_hours rows for Tue-Sat), so this isn't a new source of
// truth, just the frontend mirroring the same one.
const CLOSED_WEEKDAYS = [0, 1]; // Sun, Mon
const DAYS_AHEAD = 14;

// Sentinel for "first free chair" - carried as the selected staff so the
// rest of the flow (availability fetch, summary, booking payload) treats it
// like any barber. id 'any' is what the backend resolves to a real barber.
const ANY_BARBER = { id: 'any', name: 'First free chair' };

// Segments are flush against each other (no gap), so the thumb's `left`
// offset is always index * this value. Scaled down from mockup 7b's
// literal 78px to sit proportionate to the 44px-tall .slot-btn grid
// below it - see the .date-slider-seg comment in globals.css.
const SEGMENT_WIDTH = 56;

// Must match .date-slider-track's own padding in globals.css. Absolutely
// positioned children measure `left` from the track's padding edge (i.e.
// before the padding is applied), but the segments render inside that
// padding - without adding it back, the thumb sits this many px left of
// where the segment it's supposed to highlight actually is.
const TRACK_PADDING = 5;

// Split a day's slots into Morning / Afternoon / Evening so a long list
// of on-the-hour times scans in chunks instead of one undifferentiated
// run. Boundaries: before noon = morning, noon-4:59pm = afternoon, 5pm+ =
// evening. Groups with no slots are dropped by the render, not here.
const SLOT_PERIODS = [
  { label: 'Morning', test: (h) => h < 12 },
  { label: 'Afternoon', test: (h) => h >= 12 && h < 17 },
  { label: 'Evening', test: (h) => h >= 17 },
];

function groupSlotsByPeriod(slots) {
  return SLOT_PERIODS.map((period) => ({
    label: period.label,
    slots: slots.filter((s) => period.test(new Date(s).getHours())),
  })).filter((g) => g.slots.length > 0);
}

function buildUpcomingDays(count) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

// Default to the first open day rather than always "today" - if today is a
// Sun/Mon, landing the selection on a disabled pill would leave nothing
// pickable without the customer first clicking elsewhere themselves.
function nextOpenDateIso() {
  const days = buildUpcomingDays(DAYS_AHEAD);
  const open = days.find((d) => !CLOSED_WEEKDAYS.includes(d.getDay()));
  return toLocalDateString(open ?? days[0]);
}

// Fallback for anyone booking further out than the strip's 14-day window -
// a small FADE-styled month grid instead of falling back to the native
// <input type="date"> we just moved away from (that's the one thing that
// would've broken the dark theme again).
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function buildCalendarCells(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const startOffset = new Date(year, month, 1).getDay();
  const numDays = new Date(year, month + 1, 0).getDate();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const cells = Array(startOffset).fill(null);
  for (let d = 1; d <= numDays; d++) {
    const date = new Date(year, month, d);
    cells.push({
      iso: toLocalDateString(date),
      day: d,
      disabled: date < today || CLOSED_WEEKDAYS.includes(date.getDay()),
    });
  }
  return cells;
}

export default function BookPage() {
  const [step, setStep] = useState(0);
  const [services, setServices] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [slots, setSlots] = useState([]);
  // Distinct from the empty result: while a fetch is in flight the grid must
  // read as "loading", not "fully booked". slotsError carries a retry path
  // so a dropped request isn't a dead end.
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState(null);

  const [selectedService, setSelectedService] = useState(null);
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [selectedDate, setSelectedDate] = useState(nextOpenDateIso());
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const [customer, setCustomer] = useState({ name: '', email: '', phone: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // How far ahead the day-slider runs - owner-controlled (Settings > Booking
  // policy). Defaults to DAYS_AHEAD until the public settings load.
  const [daysAhead, setDaysAhead] = useState(DAYS_AHEAD);
  const [depositEnabled, setDepositEnabled] = useState(true);
  const [cancelWindowHours, setCancelWindowHours] = useState(24);

  useEffect(() => {
    api.getServices().then(setServices).catch((e) => setError(e.message));
    api.getStaff().then(setStaffList).catch((e) => setError(e.message));
    api.getPublicSettings()
      .then((s) => {
        setDaysAhead(s.bookingWindowDays);
        setDepositEnabled(s.depositEnabled);
        setCancelWindowHours(s.cancellationWindowHours);
      })
      .catch(() => {}); // fall back to defaults if settings can't load
  }, []);

  const loadSlots = useCallback(() => {
    if (!selectedStaff || !selectedService) return;
    let cancelled = false; // ignore a stale response if inputs changed mid-flight
    setSlots([]);
    setSelectedSlot(null);
    setSlotsError(null);
    setSlotsLoading(true);
    api
      .getAvailability(selectedStaff.id, selectedDate, selectedService.duration_minutes)
      .then((res) => { if (!cancelled) setSlots(res.slots); })
      .catch((e) => { if (!cancelled) setSlotsError(e.message); })
      .finally(() => { if (!cancelled) setSlotsLoading(false); });
    return () => { cancelled = true; };
  }, [selectedStaff, selectedService, selectedDate]);

  useEffect(() => loadSlots(), [loadSlots]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const { checkoutUrl } = await api.createAppointment({
        serviceId: selectedService.id,
        staffId: selectedStaff.id,
        startAt: selectedSlot,
        customer,
      });
      // Real Stripe Checkout redirect. In test mode, use card 4242 4242 4242 4242.
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(err.message);
      setIsSubmitting(false);
    }
  }

  function handleBack() {
    setStep((s) => Math.max(0, s - 1));
  }

  function jumpTo(i) {
    // Only allow jumping to a step already completed - mirrors the
    // sidebar's clickable-previous-steps behavior in mockup 5b, not a free
    // jump to steps whose data (e.g. available slots) hasn't loaded yet.
    if (i < step) setStep(i);
  }

  function shiftMonth(delta) {
    setCalendarMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  }

  function pickDate(iso) {
    // Stays open after a pick (unlike a native <input type="date">, which
    // closes its popup on select) - lets someone compare a couple of dates
    // against the slot grid below without re-opening the panel each time.
    // The "MORE" toggle is still there to collapse it manually.
    setSelectedDate(iso);
  }

  const upcomingDays = buildUpcomingDays(daysAhead);
  // -1 when the selected date is off the strip entirely (picked via the
  // calendar past the 14-day window) - the thumb just doesn't render then,
  // matching 7b's slBthumbShow toggle for the same case.
  const selectedDayIndex = upcomingDays.findIndex((d) => toLocalDateString(d) === selectedDate);

  const sidebarValues = [
    selectedStaff?.name ?? '',
    selectedService?.name ?? '',
    selectedSlot
      ? new Date(selectedSlot).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : '',
    '',
  ];

  // When the owner has deposits turned off, the customer pays nothing up
  // front and the full price at the chair - so the effective deposit is $0
  // regardless of the service's configured deposit_cents.
  const effectiveDepositCents = depositEnabled && selectedService ? selectedService.deposit_cents : 0;
  // Drive all deposit copy off the *effective* amount, not the global toggle:
  // a service can carry a $0 deposit even when deposits are enabled, and
  // "Pay $0 deposit" is a misleading control.
  const hasDeposit = effectiveDepositCents > 0;
  const priceLabel = selectedService ? `$${(selectedService.price_cents / 100).toFixed(0)}` : '—';
  const depositLabel = selectedService ? `$${(effectiveDepositCents / 100).toFixed(0)}` : '—';
  const balanceLabel = selectedService
    ? `$${((selectedService.price_cents - effectiveDepositCents) / 100).toFixed(0)}`
    : '—';

  return (
    <main className="book-shell">
      {/* Mobile-only sticky top: back arrow + progress dots, then a running
          summary of the choices made so far and the price. Desktop gets the
          same information from the persistent sidebar; mobile previously had
          neither, so a phone user picked a time without seeing their barber,
          service, or the cost until the final step. Sticky so it stays in
          view while the slot list scrolls. Hidden at the desktop breakpoint. */}
      <div className="book-mobile-top">
        <div className="book-mobile-header">
          <button
            type="button"
            className="circle-btn"
            onClick={handleBack}
            disabled={step === 0}
            aria-label="Back"
          >
            ←
          </button>
          <div className="progress-dots">
            {STEPS.map((_, i) => (
              <span key={i} className={`dot ${i <= step ? 'filled' : ''}`} />
            ))}
          </div>
          <span className="dep-hint">{hasDeposit ? 'DEPOSIT' : 'NO DEP'}</span>
        </div>

        {selectedStaff && (
          <div className="book-mobile-summary">
            <div className="bms-choices">
              <span className="bms-val">{selectedStaff.name}</span>
              <span className="bms-sep">·</span>
              <span className={selectedService ? 'bms-val' : 'bms-empty'}>
                {selectedService ? selectedService.name : 'pick a service'}
              </span>
              {selectedSlot && (
                <>
                  <span className="bms-sep">·</span>
                  <span className="bms-val">
                    {new Date(selectedSlot).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </>
              )}
            </div>
            {selectedService && (
              <div className="bms-price">
                <span>{priceLabel}</span>
                <span className="bms-dep">
                  {hasDeposit ? `${depositLabel} dep` : 'no deposit'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="book-grid">
        {/* Desktop-only sidebar, matching mockup 5b. Hidden on mobile via CSS. */}
        <aside className="book-sidebar">
          <Link href="/" className="brand" aria-label="FADE. — back to home">FADE.</Link>
          <div className="sidebar-steps">
            {STEPS.map((label, i) => (
              <div
                key={label}
                className={`sidebar-step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
                onClick={() => jumpTo(i)}
              >
                <span className="num">{i + 1}</span>
                <span className="lab">{label}</span>
                <span className="spacer" />
                <span className="val">{sidebarValues[i]}</span>
              </div>
            ))}
          </div>
          <div className="sidebar-summary">
            <div className="summary-row"><span className="k">Price</span><span className="v">{priceLabel}</span></div>
            <div className="summary-row"><span className="k">Deposit now</span><span className="accent-v">{depositLabel}</span></div>
            <div className="summary-row"><span className="k">At the chair</span><span className="v">{balanceLabel}</span></div>
          </div>
        </aside>

        <div className="book-content">
          <h1 className="step-headline">{HEADLINES[step]}</h1>

          {error && <p className="error-text" style={{ marginBottom: 16 }}>{error}</p>}

          {step === 0 && (
            <div>
              {/* "First free chair" as a real control, not just a caption:
                  picks the sentinel { id: 'any' } and the backend resolves an
                  actual barber at booking time from union availability. Given
                  visual priority as the fastest path. */}
              <button
                type="button"
                className={`option-card any-chair ${selectedStaff?.id === 'any' ? 'selected' : ''}`}
                onClick={() => setSelectedStaff(ANY_BARBER)}
              >
                <div className="option-card-person">
                  <div className="avatar-circle any">✂</div>
                  <div>
                    <div className="title">First free chair</div>
                    <div className="subtitle">Fastest — we&apos;ll match you with whoever&apos;s open</div>
                  </div>
                </div>
              </button>

              <div className="crew-divider"><span>or pick your barber</span></div>

              <div className="option-grid">
                {staffList.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    className={`option-card ${selectedStaff?.id === member.id ? 'selected' : ''}`}
                    onClick={() => setSelectedStaff(member)}
                  >
                    <div className="option-card-person">
                      <div className="avatar-circle">{member.name.slice(0, 1)}</div>
                      <div>
                        <div className="title">{member.name}</div>
                        <div className="subtitle">{member.bio}</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              <button className="btn" disabled={!selectedStaff} onClick={() => setStep(1)}>
                Continue
              </button>
            </div>
          )}

          {step === 1 && (
            <div>
              <div className="option-grid">
                {services.map((service) => (
                  <button
                    key={service.id}
                    type="button"
                    className={`option-card ${selectedService?.id === service.id ? 'selected' : ''}`}
                    onClick={() => setSelectedService(service)}
                  >
                    <div className="title">{service.name}</div>
                    <div className="subtitle">
                      {service.duration_minutes} min · ${(service.price_cents / 100).toFixed(0)} ·
                      {' '}${(service.deposit_cents / 100).toFixed(0)} deposit
                    </div>
                  </button>
                ))}
              </div>
              <button className="btn" disabled={!selectedService} onClick={() => setStep(2)}>
                Continue
              </button>
            </div>
          )}

          {step === 2 && (
            <div>
              {/* Segmented slider matching mockup 7b - one continuous
                  track with a lime thumb that glides to the selected
                  day, instead of each day being its own bordered pill. */}
              <div className="date-slider-row">
                <div className="date-slider-scroll">
                  <div className="date-slider-track" role="radiogroup" aria-label="Choose a day">
                    {selectedDayIndex > -1 && (
                      <div
                        className="date-slider-thumb"
                        aria-hidden="true"
                        style={{ left: selectedDayIndex * SEGMENT_WIDTH + TRACK_PADDING }}
                      />
                    )}
                    {upcomingDays.map((day, i) => {
                      const iso = toLocalDateString(day);
                      const closed = CLOSED_WEEKDAYS.includes(day.getDay());
                      const selected = i === selectedDayIndex;
                      return (
                        <button
                          key={iso}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-label={day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                          className={`date-slider-seg ${selected ? 'selected' : ''}`}
                          disabled={closed}
                          onClick={() => pickDate(iso)}
                        >
                          <span className="wk">{day.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()}</span>
                          <span className="num">{day.getDate()}</span>
                          {/* Closed days can never be selected, so a
                              selected segment's dot is always "open" -
                              just rendered dark-on-lime for contrast
                              instead of lime-on-lime (invisible). */}
                          <span className="status-dot" />
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button
                  type="button"
                  className={`date-slider-all-btn ${showCalendar ? 'active' : ''}`}
                  onClick={() => setShowCalendar((v) => !v)}
                  aria-expanded={showCalendar}
                  aria-label="Jump to another date with the calendar"
                >
                  <svg
                    width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
                    <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
                  </svg>
                  {showCalendar ? 'CLOSE' : 'DATE'}
                </button>
              </div>

              <div className="date-slider-legend">
                <span><span className="status-dot open" /> Open</span>
                <span><span className="status-dot closed" /> Closed</span>
                {/* Names the slider's range and points at the calendar as the
                    escape for anything past it, so the button isn't a mystery
                    parallel picker. */}
                {!showCalendar && (
                  <button type="button" className="date-jump-link" onClick={() => setShowCalendar(true)}>
                    Need a date further out? →
                  </button>
                )}
              </div>

              {showCalendar && (
                <div className="calendar-panel">
                  <div className="calendar-panel-title">Jump to any date</div>
                  <div className="calendar-header">
                    <button type="button" className="circle-btn" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
                    <span className="calendar-month-label">
                      {calendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase()}
                    </span>
                    <button type="button" className="circle-btn" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>
                  </div>
                  <div className="calendar-grid">
                    {WEEKDAY_LABELS.map((label, i) => (
                      <span key={`${label}-${i}`} className="calendar-weekday">{label}</span>
                    ))}
                    {buildCalendarCells(calendarMonth).map((cell, i) =>
                      cell ? (
                        <button
                          key={cell.iso}
                          type="button"
                          className={`calendar-day ${selectedDate === cell.iso ? 'selected' : ''}`}
                          disabled={cell.disabled}
                          onClick={() => pickDate(cell.iso)}
                        >
                          {cell.day}
                        </button>
                      ) : (
                        <span key={`blank-${i}`} />
                      )
                    )}
                  </div>
                </div>
              )}

              <div className="slot-list" role="radiogroup" aria-label="Available times">
                {slotsLoading ? (
                  // Skeleton rows, not a blank grid - reads as "fetching",
                  // never mistaken for "fully booked".
                  <div className="slot-group" aria-busy="true">
                    <div className="slot-group-label">Finding open times…</div>
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="slot-row slot-row-skeleton" aria-hidden="true">
                        <span className="slot-radio" />
                        <span className="skeleton-bar" />
                      </div>
                    ))}
                  </div>
                ) : slotsError ? (
                  <div className="slot-error">
                    <p className="error-text" style={{ margin: 0 }}>Couldn&apos;t load times. {slotsError}</p>
                    <button type="button" className="btn btn-secondary" style={{ marginTop: 12, padding: '10px 18px', fontSize: 13 }} onClick={loadSlots}>
                      Try again
                    </button>
                  </div>
                ) : slots.length === 0 ? (
                  <p className="empty-state">
                    {CLOSED_WEEKDAYS.includes(new Date(`${selectedDate}T00:00:00`).getDay())
                      ? "We're closed this day — pick Tue–Sat from the slider above."
                      : 'No open slots left this day — try another date or barber.'}
                  </p>
                ) : (
                  groupSlotsByPeriod(slots).map((group) => (
                    <div key={group.label} className="slot-group">
                      <div className="slot-group-label">{group.label}</div>
                      {group.slots.map((slot) => (
                        <button
                          key={slot}
                          type="button"
                          role="radio"
                          aria-checked={selectedSlot === slot}
                          className={`slot-row ${selectedSlot === slot ? 'selected' : ''}`}
                          onClick={() => setSelectedSlot(slot)}
                        >
                          <span className="slot-radio" aria-hidden="true">
                            {selectedSlot === slot && <span className="slot-radio-fill" />}
                          </span>
                          {new Date(slot).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                        </button>
                      ))}
                    </div>
                  ))
                )}
              </div>
              <button className="btn" disabled={!selectedSlot} onClick={() => setStep(3)} style={{ marginTop: 8 }}>
                Review →
              </button>
            </div>
          )}

          {step === 3 && (
            <form onSubmit={handleSubmit}>
              <div className="card" style={{ marginBottom: 20 }}>
                <div className="summary-row">
                  <span className="k">Barber</span>
                  <span className="v">{selectedStaff?.name}</span>
                </div>
                <div className="summary-row">
                  <span className="k">Service</span>
                  <span className="v">{selectedService?.name}</span>
                </div>
                <div className="summary-row">
                  <span className="k">Time</span>
                  <span className="v">
                    {selectedSlot && new Date(selectedSlot).toLocaleString('en-US', {
                      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </div>
                <div className="summary-row total">
                  <span className="k">Price</span>
                  <span className="v">{priceLabel}</span>
                </div>
                <div className="summary-row">
                  <span className="k">Deposit now</span>
                  <span className="accent-v">{depositLabel}</span>
                </div>
                <div className="summary-row">
                  <span className="k">At the chair</span>
                  <span className="v">{balanceLabel}</span>
                </div>
              </div>

              <div className="form-group">
                <label>Full name</label>
                <input
                  required
                  value={customer.name}
                  onChange={(e) => setCustomer((c) => ({ ...c, name: e.target.value }))}
                />
              </div>
              <div className="form-group">
                <label>Email</label>
                <input
                  required
                  type="email"
                  value={customer.email}
                  onChange={(e) => setCustomer((c) => ({ ...c, email: e.target.value }))}
                />
              </div>
              <div className="form-group">
                <label>Phone (optional)</label>
                <input
                  value={customer.phone}
                  onChange={(e) => setCustomer((c) => ({ ...c, phone: e.target.value }))}
                />
              </div>
              <button className="btn" type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? (hasDeposit ? 'Redirecting to payment…' : 'Confirming…')
                  : (hasDeposit ? `Pay ${depositLabel} deposit` : 'Confirm booking')}
              </button>
              <p className="helper-note">
                {hasDeposit
                  ? `Deposit refundable up to ${cancelWindowHours}h before · unpaid holds expire in a few minutes.`
                  : `Free to cancel up to ${cancelWindowHours}h before.`}
              </p>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}

// `new Date().toISOString().slice(0, 10)` reads the date in UTC, so anyone
// west of UTC before midnight, or east of UTC after 11pm-ish, would get the
// wrong calendar day out of this. Using local getFullYear/getMonth/getDate
// fixes it for the browser's own clock. Same fix applied in
// book/manage/page.js and dashboard/page.js.
function toLocalDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
