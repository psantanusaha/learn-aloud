import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { ActivityService, ActivityEvent, ActivityState } from '../../services/activity.service';

@Component({
  selector: 'app-activity-monitor',
  standalone: true,
  templateUrl: './activity-monitor.component.html',
  styleUrls: ['./activity-monitor.component.css'],
})
export class ActivityMonitorComponent implements OnInit, OnDestroy {
  events: ActivityEvent[] = [];
  state: ActivityState = {
    voiceConnected: false,
    voicePaused: false,
    mcpConnected: false,
    sessionId: '',
    fileName: '',
  };

  constructor(
    private activity: ActivityService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.activity.onMessage((msg) => {
      if (msg.type === 'event') {
        this.events = [...this.events, msg.payload];
        this.cdr.detectChanges();
        this.scrollToBottom();
      } else if (msg.type === 'state') {
        this.state = msg.payload;
        this.cdr.detectChanges();
      }
    });
  }

  ngOnDestroy(): void {
    this.activity.onMessage(() => {});
  }

  formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false });
  }

  categoryLabel(cat: string): string {
    return cat.toUpperCase();
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      const el = document.querySelector('.timeline-entries');
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
}
