import { Injectable } from '@angular/core';
import { UserService } from './user.service';

export interface SessionRecord {
  id: string;
  date: string;
  fileName: string;
  transcript: { sender: 'you' | 'agent'; text: string }[];
  topicSummary: string;
}

const STORAGE_PREFIX = 'learnaloud_sessions_';

@Injectable({ providedIn: 'root' })
export class SessionService {
  constructor(private userService: UserService) {}

  saveSession(fileName: string, transcript: { sender: 'you' | 'agent'; text: string }[]): void {
    if (!transcript.length) return;

    const record: SessionRecord = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      fileName,
      transcript,
      topicSummary: this.buildSummary(transcript),
    };

    const sessions = this.getSessions();
    sessions.unshift(record);
    this.saveSessions(sessions);
  }

  getSessions(): SessionRecord[] {
    const key = this.storageKey();
    if (!key) return [];
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  }

  getLatestSession(): SessionRecord | null {
    const sessions = this.getSessions();
    return sessions.length > 0 ? sessions[0] : null;
  }

  getLatestSessionForFile(fileName: string): SessionRecord | null {
    const sessions = this.getSessions();
    return sessions.find(s => s.fileName === fileName) || null;
  }

  clearSessions(): void {
    const key = this.storageKey();
    if (key) localStorage.removeItem(key);
  }

  private buildSummary(transcript: { sender: 'you' | 'agent'; text: string }[]): string {
    const agentEntry = transcript.find(e => e.sender === 'agent');
    if (agentEntry) {
      return agentEntry.text.length > 120
        ? agentEntry.text.substring(0, 120) + '...'
        : agentEntry.text;
    }
    const first = transcript[0];
    return first.text.length > 120
      ? first.text.substring(0, 120) + '...'
      : first.text;
  }

  private storageKey(): string | null {
    const email = this.userService.currentUser?.email;
    if (!email) return null;
    return STORAGE_PREFIX + email;
  }

  private saveSessions(sessions: SessionRecord[]): void {
    const key = this.storageKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(sessions));
  }
}
