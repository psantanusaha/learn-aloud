import { Injectable } from '@angular/core';
import { UserService } from './user.service';
import {
  ConceptNode,
  SpacedRepetitionData,
  SessionSummaryPayload,
} from '../models/knowledge.model';

const CONCEPTS_PREFIX = 'learnaloud_concepts_';
const SR_PREFIX = 'learnaloud_sr_';

@Injectable({ providedIn: 'root' })
export class KnowledgeService {
  constructor(private userService: UserService) {}

  processSessionSummary(payload: SessionSummaryPayload, sessionId: string): void {
    if (!payload?.concepts?.length) return;

    const concepts = this.getConcepts();
    const srData = this.getSRData();

    for (const incoming of payload.concepts) {
      const normalized = incoming.name.trim().toLowerCase();
      let existing = concepts.find(c => c.name.toLowerCase() === normalized);

      if (existing) {
        existing.mastery = incoming.mastery;
        existing.status = this.validStatus(incoming.status);
        existing.lastReviewed = new Date().toISOString();
        if (!existing.sessionIds.includes(sessionId)) {
          existing.sessionIds.push(sessionId);
        }
      } else {
        existing = {
          id: crypto.randomUUID(),
          name: incoming.name.trim(),
          mastery: incoming.mastery,
          status: this.validStatus(incoming.status),
          firstSeen: new Date().toISOString(),
          lastReviewed: new Date().toISOString(),
          sessionIds: [sessionId],
          relatedConcepts: [],
        };
        concepts.push(existing);
      }

      // Update SR data
      const quality = this.masteryToQuality(incoming.mastery);
      this.updateSREntry(srData, existing.id, quality);
    }

    // Resolve relationships
    for (const incoming of payload.concepts) {
      const node = concepts.find(c => c.name.toLowerCase() === incoming.name.trim().toLowerCase());
      if (!node) continue;

      for (const relName of (incoming.relatedTo || [])) {
        const relNode = concepts.find(c => c.name.toLowerCase() === relName.trim().toLowerCase());
        if (relNode && relNode.id !== node.id) {
          if (!node.relatedConcepts.includes(relNode.id)) {
            node.relatedConcepts.push(relNode.id);
          }
          if (!relNode.relatedConcepts.includes(node.id)) {
            relNode.relatedConcepts.push(node.id);
          }
        }
      }
    }

    this.saveConcepts(concepts);
    this.saveSRData(srData);
  }

  updateSR(conceptId: string, quality: number): void {
    const srData = this.getSRData();
    this.updateSREntry(srData, conceptId, quality);
    this.saveSRData(srData);
  }

  getConcepts(): ConceptNode[] {
    const key = this.conceptsKey();
    if (!key) return [];
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  }

  getSRData(): SpacedRepetitionData[] {
    const key = this.srKey();
    if (!key) return [];
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  }

  getConceptsDueForReview(): { concept: ConceptNode; sr: SpacedRepetitionData }[] {
    const concepts = this.getConcepts();
    const srData = this.getSRData();
    const today = this.todayStr();
    const results: { concept: ConceptNode; sr: SpacedRepetitionData }[] = [];

    for (const sr of srData) {
      if (sr.nextReviewDate <= today) {
        const concept = concepts.find(c => c.id === sr.conceptId);
        if (concept) {
          results.push({ concept, sr });
        }
      }
    }
    return results;
  }

  getUpcomingReviews(days: number): Map<string, { concept: ConceptNode; sr: SpacedRepetitionData }[]> {
    const concepts = this.getConcepts();
    const srData = this.getSRData();
    const result = new Map<string, { concept: ConceptNode; sr: SpacedRepetitionData }[]>();

    const start = new Date();
    for (let d = 0; d < days; d++) {
      const date = new Date(start);
      date.setDate(date.getDate() + d);
      const dateStr = date.toISOString().split('T')[0];
      result.set(dateStr, []);
    }

    for (const sr of srData) {
      const reviewDate = sr.nextReviewDate;
      if (result.has(reviewDate)) {
        const concept = concepts.find(c => c.id === sr.conceptId);
        if (concept) {
          result.get(reviewDate)!.push({ concept, sr });
        }
      }
    }

    return result;
  }

  private updateSREntry(srData: SpacedRepetitionData[], conceptId: string, quality: number): void {
    quality = Math.max(0, Math.min(5, Math.round(quality)));
    let entry = srData.find(s => s.conceptId === conceptId);

    if (!entry) {
      entry = {
        conceptId,
        easeFactor: 2.5,
        interval: 1,
        repetitions: 0,
        nextReviewDate: this.todayStr(),
        lastReviewDate: this.todayStr(),
        quality,
      };
      srData.push(entry);
    }

    // SM2 algorithm
    entry.quality = quality;
    entry.lastReviewDate = this.todayStr();

    if (quality >= 3) {
      if (entry.repetitions === 0) {
        entry.interval = 1;
      } else if (entry.repetitions === 1) {
        entry.interval = 6;
      } else {
        entry.interval = Math.round(entry.interval * entry.easeFactor);
      }
      entry.repetitions++;
    } else {
      entry.repetitions = 0;
      entry.interval = 1;
    }

    entry.easeFactor = entry.easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    if (entry.easeFactor < 1.3) entry.easeFactor = 1.3;

    const next = new Date();
    next.setDate(next.getDate() + entry.interval);
    entry.nextReviewDate = next.toISOString().split('T')[0];
  }

  private masteryToQuality(mastery: number): number {
    if (mastery >= 80) return 5;
    if (mastery >= 60) return 4;
    if (mastery >= 40) return 3;
    if (mastery >= 20) return 2;
    return 1;
  }

  private validStatus(s: string): ConceptNode['status'] {
    const valid: ConceptNode['status'][] = ['learning', 'reviewing', 'mastered', 'struggling'];
    return valid.includes(s as any) ? (s as ConceptNode['status']) : 'learning';
  }

  private todayStr(): string {
    return new Date().toISOString().split('T')[0];
  }

  private conceptsKey(): string | null {
    const email = this.userService.currentUser?.email;
    if (!email) return null;
    return CONCEPTS_PREFIX + email;
  }

  private srKey(): string | null {
    const email = this.userService.currentUser?.email;
    if (!email) return null;
    return SR_PREFIX + email;
  }

  private saveConcepts(concepts: ConceptNode[]): void {
    const key = this.conceptsKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(concepts));
  }

  private saveSRData(srData: SpacedRepetitionData[]): void {
    const key = this.srKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(srData));
  }
}
