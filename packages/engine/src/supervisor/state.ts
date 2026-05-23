export interface WorkflowActivity {
  runningTasks: Set<string>;
  lastEventAt: number;
  lastAlertAt: number;
}

export interface PendingCiExhaustion {
  wfId: string;
  taskId: string;
  since: number;
  alerted: boolean;
}

export class SupervisorState {
  pushFailureWindow: number[] = [];
  activity = new Map<string, WorkflowActivity>();
  pendingCiExhaustion = new Map<string, PendingCiExhaustion>();
  recentAlerts = new Map<string, number>();
}
