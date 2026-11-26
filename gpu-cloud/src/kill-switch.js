// NOVA Personal GPU Cloud — Stage 1: kill-switch state.
//
// The kill-switch stops NEW dispatches. It does NOT stop a GPU job that
// is already running (reviewer VDP-02): a gateway kill cannot guarantee a
// running job stops, that a provider will not charge for an accepted job,
// or that a timed-out request is not still running remotely. The manager
// therefore marks running jobs "cancellation requested" and records
// whatever outcome the provider eventually reports.
//
// Every engage/disengage is logged with a reason and a timestamp.

export function engageKillSwitch(state, reason, now) {
  state.killSwitch.engaged = true;
  state.killSwitch.reason = reason;
  state.killSwitch.engagedAt = now;
  state.killSwitch.log.push({ action: 'engaged', reason, at: now });
}

export function disengageKillSwitch(state, reason, now) {
  state.killSwitch.engaged = false;
  state.killSwitch.reason = null;
  state.killSwitch.engagedAt = null;
  state.killSwitch.log.push({ action: 'disengaged', reason, at: now });
}

export function isEngaged(state) {
  return state.killSwitch.engaged === true;
}
