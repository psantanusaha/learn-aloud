import { Injectable, OnDestroy } from '@angular/core';

export interface ActivityEvent {
  id: string;
  timestamp: number;
  category: 'transcript' | 'action' | 'state' | 'mcp';
  title: string;
  detail?: string;
  metadata?: Record<string, any>;
}

export interface ActivityState {
  voiceConnected: boolean;
  voicePaused: boolean;
  mcpConnected: boolean;
  sessionId: string;
  fileName: string;
}

@Injectable({ providedIn: 'root' })
export class ActivityService implements OnDestroy {
  private channel: BroadcastChannel;
  private counter = 0;

  constructor() {
    this.channel = new BroadcastChannel('learnaloud-activity');
  }

  ngOnDestroy(): void {
    this.channel.close();
  }

  post(event: Omit<ActivityEvent, 'id' | 'timestamp'>): void {
    const full: ActivityEvent = {
      ...event,
      id: `evt-${Date.now()}-${this.counter++}`,
      timestamp: Date.now(),
    };
    this.channel.postMessage({ type: 'event', payload: full });
  }

  postState(state: ActivityState): void {
    this.channel.postMessage({ type: 'state', payload: state });
  }

  onMessage(callback: (msg: { type: string; payload: any }) => void): void {
    this.channel.onmessage = (ev) => callback(ev.data);
  }
}
