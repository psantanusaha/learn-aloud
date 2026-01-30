import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConceptNode, SpacedRepetitionData } from '../../models/knowledge.model';

export interface ReviewItem {
  concept: ConceptNode;
  sr: SpacedRepetitionData;
}

@Component({
  selector: 'app-spaced-repetition',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './spaced-repetition.component.html',
  styleUrls: ['./spaced-repetition.component.css'],
})
export class SpacedRepetitionComponent {
  @Input() dueForReview: ReviewItem[] = [];
  @Input() upcomingReviews: Map<string, ReviewItem[]> = new Map();

  get calendarDays(): { date: string; label: string; items: ReviewItem[] }[] {
    const days: { date: string; label: string; items: ReviewItem[] }[] = [];
    const entries = Array.from(this.upcomingReviews.entries());
    for (const [dateStr, items] of entries) {
      const d = new Date(dateStr + 'T00:00:00');
      days.push({
        date: dateStr,
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        items,
      });
    }
    return days;
  }

  statusColor(status: ConceptNode['status']): string {
    switch (status) {
      case 'mastered': return '#4caf50';
      case 'reviewing': return '#ff9800';
      case 'learning': return '#5c6bc0';
      case 'struggling': return '#e53935';
      default: return '#9b9b9b';
    }
  }

  isToday(dateStr: string): boolean {
    return dateStr === new Date().toISOString().split('T')[0];
  }
}
