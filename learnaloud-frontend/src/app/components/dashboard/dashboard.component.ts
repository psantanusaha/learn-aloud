import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { KnowledgeService } from '../../services/knowledge.service';
import { SessionService, SessionRecord } from '../../services/session.service';
import { ConceptNode, SpacedRepetitionData, SessionStats } from '../../models/knowledge.model';
import { KnowledgeMapComponent } from './knowledge-map.component';
import { SpacedRepetitionComponent, ReviewItem } from './spaced-repetition.component';
import { SessionStatsComponent } from './session-stats.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    KnowledgeMapComponent,
    SpacedRepetitionComponent,
    SessionStatsComponent,
  ],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
})
export class DashboardComponent implements OnInit {
  concepts: ConceptNode[] = [];
  srData: SpacedRepetitionData[] = [];
  dueForReview: ReviewItem[] = [];
  upcomingReviews = new Map<string, ReviewItem[]>();
  sessionStats: SessionStats[] = [];

  constructor(
    private knowledgeService: KnowledgeService,
    private sessionService: SessionService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.concepts = this.knowledgeService.getConcepts();
    this.srData = this.knowledgeService.getSRData();
    this.dueForReview = this.knowledgeService.getConceptsDueForReview();
    this.upcomingReviews = this.knowledgeService.getUpcomingReviews(14);
    this.sessionStats = this.buildSessionStats();
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  private buildSessionStats(): SessionStats[] {
    const sessions: SessionRecord[] = this.sessionService.getSessions();
    return sessions.map(s => {
      const studentMsgs = s.transcript.filter(e => e.sender === 'you').length;
      const tutorMsgs = s.transcript.filter(e => e.sender === 'agent').length;
      // Rough duration estimate: ~30 seconds per message exchange
      const durationEstimate = Math.max(1, Math.round(s.transcript.length * 0.5));
      // Extract topic words from the first few tutor messages
      const tutorTexts = s.transcript
        .filter(e => e.sender === 'agent')
        .slice(0, 3)
        .map(e => e.text);
      const topicsCovered = this.extractTopics(tutorTexts);

      return {
        sessionId: s.id,
        fileName: s.fileName,
        date: s.date,
        durationEstimateMinutes: durationEstimate,
        messageCount: s.transcript.length,
        studentMessages: studentMsgs,
        tutorMessages: tutorMsgs,
        topicsCovered,
        topicSummary: s.topicSummary,
      };
    });
  }

  private extractTopics(texts: string[]): string[] {
    // Simple keyword extraction: look for concept names from the knowledge base
    const topics = new Set<string>();
    const combined = texts.join(' ').toLowerCase();
    for (const concept of this.concepts) {
      if (combined.includes(concept.name.toLowerCase())) {
        topics.add(concept.name);
      }
    }
    // If no concepts matched, extract capitalized multi-word phrases
    if (topics.size === 0 && combined.length > 0) {
      const fullText = texts.join(' ');
      const matches = fullText.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
      if (matches) {
        for (const m of matches.slice(0, 5)) {
          topics.add(m);
        }
      }
    }
    return Array.from(topics).slice(0, 8);
  }
}
