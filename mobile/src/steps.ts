/** A step's state as the web shows it (server ToolCallBody.status), for the Android steps row. */
export type StepState = 'running' | 'done' | 'failed' | 'denied' | 'waiting';

export function stepState(status: unknown): StepState {
  switch (status) {
    case 'running': return 'running';
    case 'error': return 'failed';
    case 'denied': return 'denied';
    case 'awaiting-approval': return 'waiting';
    default: return 'done';
  }
}

export const STEP_LABEL: Record<StepState, string> = { running: 'Running', done: 'Done', failed: "Didn't work", denied: 'Not allowed', waiting: 'Waiting for you' };
