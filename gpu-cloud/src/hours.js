// NOVA Personal GPU Cloud — Stage 2: weekly GPU-hours tracking.
//
// Free GPU tiers are QUOTA-limited, not bill-limited: Kaggle gives 30
// GPU-hours/week, Colab ~12-15h/week (unpublished, variable — the tracker
// uses 12h as the conservative planning figure, taken from the provider
// definition). The tracker records usage against the weekly budget in the
// store's providerState, so the dispatcher stops assigning work when a
// budget is spent.
//
// Wiring (no Stage 1 contract change): the executor records usage after
// each completed job and, when a budget is spent, flips the provider's
// registry status to 'unavailable' (dispatchable() already requires
// status === 'available'). The tracker also writes
// providerState[providerId].status = 'budget-spent' so the spent state
// survives a restart; on week rollover the status returns to 'available'
// (the registry itself is rebuilt from definitions on restart, and real
// providers start not-connected until Part B flips them).
//
// Week definition: the week starts at weekStartDay 00:00 UTC. Kaggle's
// reset day is reported as Saturday 00:00 UTC (third-party research
// against Kaggle's docs, 2026-06 — NOT verified from Kaggle directly), so
// Saturday (6) is the default; pass weekStartDay to override. Part B
// confirms the real reset day via `kaggle quota` and corrects this if
// needed. Colab publishes no reset schedule at all — the same weekly
// window is used as a planning device only.
//
// Store shape: providerState[providerId] = { status, hoursUsedThisWeek,
// weekStart, updatedAt }. The `weekStart` field is ADDITIVE inside the
// existing providerState object (defaultState() already documents
// providerState entries); no store version bump is needed. Entries
// written before Stage 2 have no weekStart and are treated as belonging
// to an unknown week — they roll over once on first use.

export const MS_PER_HOUR = 3600 * 1000;
export const MS_PER_WEEK = 7 * 24 * MS_PER_HOUR;

// Default week-start day: Saturday (6), per the reported Kaggle reset
// (~Sat 00:00 UTC). Reported, not verified — see the module header.
export const DEFAULT_WEEK_START_DAY = 6;

// Start of the week (ms epoch, UTC) containing `nowMs`, for a week
// starting on `weekStartDay` (0 = Sunday .. 6 = Saturday).
export function weekStartMs(nowMs, weekStartDay = DEFAULT_WEEK_START_DAY) {
  const d = new Date(nowMs);
  const day = d.getUTCDay();
  const daysBack = (day - weekStartDay + 7) % 7;
  const start = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - daysBack,
    0, 0, 0, 0,
  );
  return start;
}

export class HoursTracker {
  // store: the manager's JsonStore (providerState lives there).
  // budgets: { providerId: hoursPerWeek } — taken from the provider
  //   definitions' availabilityWindow.hoursPerWeek by the setup factory.
  //   Providers without a weekly budget are not tracked (no cutoff).
  constructor({
    store,
    budgets = {},
    weekStartDay = DEFAULT_WEEK_START_DAY,
    now = () => Date.now(),
  } = {}) {
    if (!store) throw new Error('HoursTracker requires a store');
    this.store = store;
    this.budgets = { ...budgets };
    this.weekStartDay = weekStartDay;
    this.now = now;
  }

  budgetHours(providerId) {
    const b = this.budgets[providerId];
    return typeof b === 'number' && b > 0 ? b : null;
  }

  // Current usage for a provider (rollover applied lazily — a stored week
  // that is not the current week reads as 0 used). Does not write.
  usage(providerId, nowMs = this.now()) {
    const budget = this.budgetHours(providerId);
    if (budget === null) {
      return {
        providerId,
        tracked: false,
        hoursUsed: 0,
        hoursBudget: null,
        hoursRemaining: null,
        weekStart: weekStartMs(nowMs, this.weekStartDay),
        spent: false,
      };
    }
    const start = weekStartMs(nowMs, this.weekStartDay);
    const entry = this.store.state.providerState[providerId];
    const currentWeek = entry && entry.weekStart === start;
    const hoursUsed = currentWeek ? entry.hoursUsedThisWeek || 0 : 0;
    return {
      providerId,
      tracked: true,
      hoursUsed,
      hoursBudget: budget,
      hoursRemaining: Math.max(0, budget - hoursUsed),
      weekStart: start,
      spent: hoursUsed >= budget,
    };
  }

  isSpent(providerId, nowMs = this.now()) {
    return this.usage(providerId, nowMs).spent;
  }

  // Record completed GPU seconds against the current week. Rolls the week
  // over first if the stored week is stale. Returns the updated usage.
  recordUsage(providerId, secondsUsed, nowMs = this.now()) {
    if (typeof secondsUsed !== 'number' || !Number.isFinite(secondsUsed) || secondsUsed < 0) {
      throw new Error('secondsUsed must be a finite number >= 0');
    }
    const budget = this.budgetHours(providerId);
    if (budget === null) return this.usage(providerId, nowMs);
    const start = weekStartMs(nowMs, this.weekStartDay);
    let updated;
    this.store.mutate((s) => {
      const prev = s.providerState[providerId] ?? {};
      const currentWeek = prev.weekStart === start;
      const hoursUsed =
        (currentWeek ? prev.hoursUsedThisWeek || 0 : 0) + secondsUsed / 3600;
      updated = {
        status: hoursUsed >= budget ? 'budget-spent' : 'available',
        hoursUsedThisWeek: hoursUsed,
        weekStart: start,
        updatedAt: nowMs,
      };
      s.providerState[providerId] = updated;
    });
    return {
      providerId,
      tracked: true,
      hoursUsed: updated.hoursUsedThisWeek,
      hoursBudget: budget,
      hoursRemaining: Math.max(0, budget - updated.hoursUsedThisWeek),
      weekStart: start,
      spent: updated.hoursUsedThisWeek >= budget,
    };
  }

  // Ensure the stored week is current (roll over without recording usage).
  // Used at dispatch time so a stale spent status does not block a new
  // week's work after a restart. The returned usage carries `rolledOver`
  // (true when this call rolled the week) so the registry sync can tell
  // a rollover apart from a manual disable.
  checkWeek(providerId, nowMs = this.now()) {
    const budget = this.budgetHours(providerId);
    if (budget === null) return { ...this.usage(providerId, nowMs), rolledOver: false };
    const start = weekStartMs(nowMs, this.weekStartDay);
    const entry = this.store.state.providerState[providerId];
    let rolledOver = false;
    if (entry && entry.weekStart !== start) {
      rolledOver = true;
      this.store.mutate((s) => {
        s.providerState[providerId] = {
          status: 'available',
          hoursUsedThisWeek: 0,
          weekStart: start,
          updatedAt: nowMs,
        };
      });
    }
    return { ...this.usage(providerId, nowMs), rolledOver };
  }
}

// Reconcile a provider's REGISTRY status (the dispatch gate) with its
// tracked weekly budget. Called at startup (setup.js), at dispatch time
// (executor start), and after a completion is recorded:
//   - budget spent + registry 'available'  -> 'unavailable' (stop assigning)
//   - week rolled over + registry 'unavailable' -> 'available' (new week;
//     only when the rollover just happened, so a manual disable is never
//     silently undone)
// A provider that was never connected ('not-connected') is left alone —
// the live connection check (Part B) is what flips it to 'available'.
export function syncBudgetStatus(registry, tracker, providerId, nowMs = tracker.now()) {
  const usage = tracker.checkWeek(providerId, nowMs);
  if (!usage.tracked) return usage;
  const p = registry.get(providerId);
  if (!p) return usage;
  if (usage.spent) {
    if (p.status === 'available') registry.setStatus(providerId, 'unavailable');
  } else if (usage.rolledOver && p.status === 'unavailable' && p.connected) {
    registry.setStatus(providerId, 'available');
  }
  return usage;
}
