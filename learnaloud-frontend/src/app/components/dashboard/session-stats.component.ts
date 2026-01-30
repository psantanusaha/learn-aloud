import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionStats } from '../../models/knowledge.model';

@Component({
  selector: 'app-session-stats',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './session-stats.component.html',
  styleUrls: ['./session-stats.component.css'],
})
export class SessionStatsComponent {
  @Input() stats: SessionStats[] = [];

  expandedId: string | null = null;

  toggleExpand(id: string): void {
    this.expandedId = this.expandedId === id ? null : id;
  }

  studentRatio(s: SessionStats): number {
    return s.messageCount > 0 ? (s.studentMessages / s.messageCount) * 100 : 50;
  }
}
