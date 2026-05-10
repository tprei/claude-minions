export interface WorkflowActivity {
  hasRunningTask: boolean;
  lastEventAt: number;
  lastAlertAt: number;
}

export class SupervisorState {
  pushFailureWindow: number[] = [];
  activity = new Map<string, WorkflowActivity>();
  pendingCiExhaustion = new Map<string, { since: number; alerted: boolean }>();
  recentAlerts = new Map<string, number>();
}
