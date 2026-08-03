/**
 * Defensive state machine for the CliSpawner streaming conversation lifecycle.
 *
 * States: IDLE -> THINKING -> STREAMING -> INTERRUPTING -> IDLE (or ERROR).
 *
 * Invalid transitions are rejected at the TYPE level: `transition()` only
 * accepts (state, event) pairs declared in `Transitions`, so a disallowed
 * combination is a compile-time error. The runtime `reduce()` additionally
 * treats unknown transitions as no-ops for safety against unexpected events.
 */

export type StreamState = 'IDLE' | 'THINKING' | 'STREAMING' | 'INTERRUPTING' | 'ERROR';

export type StreamMachineEvent =
  | { type: 'SEND' }          // user submitted a message
  | { type: 'FIRST_CHUNK' }   // first streamed chunk arrived
  | { type: 'RESUME' }        // bound a window to an already-streaming conversation
  | { type: 'STOP_REQUESTED' }// user hit Stop (visible INTERRUPTING state)
  | { type: 'STOPPED' }       // stream:end (completed or interrupted)
  | { type: 'ERROR' }         // stream:error
  | { type: 'RESET' };        // clear an error / re-arm for retry

/** Declared transitions: state -> event -> next state. Unlisted pairs are invalid. */
interface Transitions {
  IDLE: { SEND: 'THINKING'; RESUME: 'STREAMING'; RESET: 'IDLE' };
  THINKING: { FIRST_CHUNK: 'STREAMING'; RESUME: 'STREAMING'; STOP_REQUESTED: 'INTERRUPTING'; STOPPED: 'IDLE'; ERROR: 'ERROR' };
  STREAMING: { STOP_REQUESTED: 'INTERRUPTING'; STOPPED: 'IDLE'; ERROR: 'ERROR' };
  INTERRUPTING: { STOPPED: 'IDLE'; ERROR: 'ERROR' };
  ERROR: { RESET: 'IDLE'; SEND: 'THINKING' };
}

const TABLE: { [S in StreamState]: Transitions[S] } = {
  IDLE: { SEND: 'THINKING', RESUME: 'STREAMING', RESET: 'IDLE' },
  THINKING: { FIRST_CHUNK: 'STREAMING', RESUME: 'STREAMING', STOP_REQUESTED: 'INTERRUPTING', STOPPED: 'IDLE', ERROR: 'ERROR' },
  STREAMING: { STOP_REQUESTED: 'INTERRUPTING', STOPPED: 'IDLE', ERROR: 'ERROR' },
  INTERRUPTING: { STOPPED: 'IDLE', ERROR: 'ERROR' },
  ERROR: { RESET: 'IDLE', SEND: 'THINKING' },
};

/**
 * Type-safe transition. The `E extends keyof Transitions[S]` constraint makes
 * `transition(state, event)` a compile-time error for any event not valid in
 * `state` - invalid transitions are rejected at the type level.
 */
export function transition<S extends StreamState, E extends keyof Transitions[S]>(
  state: S,
  event: E,
): Transitions[S][E] {
  return (TABLE[state] as Transitions[S])[event];
}

/** Runtime-safe reducer: invalid/unknown transitions are no-ops (stay put). */
export function reduce(state: StreamState, event: StreamMachineEvent): StreamState {
  const allowed = TABLE[state] as unknown as Record<string, StreamState>;
  if (allowed && event.type in allowed) {
    return allowed[event.type];
  }
  return state;
}

/** Whether the input box should be locked (active processing or mid-interrupt). */
export function isInputLocked(state: StreamState): boolean {
  return state === 'THINKING' || state === 'STREAMING' || state === 'INTERRUPTING';
}

/** Whether a stream is actively running (preserves legacy `isStreaming` semantics). */
export function isStreamActive(state: StreamState): boolean {
  return isInputLocked(state);
}
