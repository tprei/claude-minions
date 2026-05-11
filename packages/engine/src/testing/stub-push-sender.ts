import type { PushSendResult, PushSendTarget, PushSender } from "../plugins/push-sender.js";

export interface PushSendCall {
  target: PushSendTarget;
  payload: string;
}

export class StubPushSender implements PushSender {
  readonly calls: PushSendCall[] = [];
  private responseQueue: PushSendResult[] = [];
  private defaultResponse: PushSendResult = { ok: true };

  queueResponse(result: PushSendResult): void {
    this.responseQueue.push(result);
  }

  setDefaultResponse(result: PushSendResult): void {
    this.defaultResponse = result;
  }

  async send(target: PushSendTarget, payload: string): Promise<PushSendResult> {
    this.calls.push({ target, payload });
    if (this.responseQueue.length > 0) {
      return this.responseQueue.shift()!;
    }
    return this.defaultResponse;
  }
}
