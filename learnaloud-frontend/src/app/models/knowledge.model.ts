export interface ConceptNode {
  id: string;
  name: string;
  mastery: number;               // 0-100
  status: 'learning' | 'reviewing' | 'mastered' | 'struggling';
  firstSeen: string;             // ISO date
  lastReviewed: string;          // ISO date
  sessionIds: string[];
  relatedConcepts: string[];     // IDs of related ConceptNodes
}

export interface SpacedRepetitionData {
  conceptId: string;
  easeFactor: number;            // starts 2.5, min 1.3
  interval: number;              // days until next review
  repetitions: number;           // consecutive correct recalls
  nextReviewDate: string;        // ISO date
  lastReviewDate: string;
  quality: number;               // last recall quality 0-5
}

export interface SessionSummaryPayload {
  concepts: { name: string; mastery: number; status: string; relatedTo: string[] }[];
  overallPerformance: 'excellent' | 'good' | 'fair' | 'needs_work';
  keyTakeaways: string[];
}

export interface SessionStats {
  sessionId: string;
  fileName: string;
  date: string;
  durationEstimateMinutes: number;
  messageCount: number;
  studentMessages: number;
  tutorMessages: number;
  topicsCovered: string[];
  topicSummary: string;
}
