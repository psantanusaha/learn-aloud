import { Injectable } from '@angular/core';
import {
  Room,
  RoomEvent,
  Track,
  RemoteTrackPublication,
  RemoteParticipant,
  DataPacket_Kind,
  TranscriptionSegment,
  Participant,
} from 'livekit-client';

export interface TranscriptEntry {
  sender: 'you' | 'agent';
  text: string;
  isFinal: boolean;
  id: string;
  role?: 'tutor' | 'author' | 'reviewer';
}

export interface VoiceState {
  isConnected: boolean;
  isConnecting: boolean;
  isMicEnabled: boolean;
}

@Injectable({ providedIn: 'root' })
export class VoiceService {
  private room: Room | null = null;
  private onClientAction: ((action: any) => void) | null = null;
  private onTranscript: ((transcript: TranscriptEntry[]) => void) | null = null;
  private audioElements: HTMLElement[] = [];

  // Debate mode state
  private authorRoom: Room | null = null;
  private reviewerRoom: Room | null = null;
  private authorAudioElements: HTMLElement[] = [];
  private reviewerAudioElements: HTMLElement[] = [];
  isDebateMode = false;
  activeSpeaker: 'author' | 'reviewer' | null = null;

  transcript: TranscriptEntry[] = [];
  isConnected = false;
  isConnecting = false;
  isMicEnabled = true;
  isPaused = false;
  micError = '';

  async connect(url: string, token: string): Promise<void> {
    if (this.room) {
      try {
        await this.room.disconnect(true);
      } catch (_) { /* ignore stale room cleanup */ }
      this.room = null;
      this.audioElements.forEach(el => el.remove());
      this.audioElements = [];
    }

    this.isConnecting = true;
    this.isConnected = false;
    this.isDebateMode = false;
    this.transcript = [];
    this.room = new Room();

    this.room.on(
      RoomEvent.TrackSubscribed,
      (track, _pub: RemoteTrackPublication, _participant: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.id = 'lk-agent-audio';
          this.audioElements.push(el);
          // Apply current pause state if already paused
          this.applyPauseStateToElement(el);
          document.body.appendChild(el);
        }
      }
    );

    this.room.on(
      RoomEvent.TrackUnsubscribed,
      (track) => {
        track.detach().forEach((el) => {
          const index = this.audioElements.indexOf(el);
          if (index > -1) {
            this.audioElements.splice(index, 1);
          }
          el.remove();
        });
      }
    );

    this.room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant, _kind?: DataPacket_Kind, topic?: string) => {
        const raw = new TextDecoder().decode(payload);
        console.log('[VoiceService] DataReceived topic:', topic, 'raw:', raw);
        if (topic !== 'client_actions') return;
        try {
          const msg = JSON.parse(raw);
          let action: any;
          if (msg.type === 'client_action' && msg.action) {
            action = { type: msg.action, payload: msg.payload };
          } else {
            action = msg;
          }
          console.log('[VoiceService] Forwarding action:', action);
          this.onClientAction?.(action);
        } catch (e) {
          console.warn('VoiceService: failed to parse data message', e);
        }
      }
    );

    this.room.on(
      RoomEvent.TranscriptionReceived,
      (segments: TranscriptionSegment[], participant?: Participant) => {
        const isAgent = participant instanceof RemoteParticipant;
        const sender = isAgent ? 'agent' : 'you';
        for (const seg of segments) {
          const idx = this.transcript.findIndex((e) => e.id === seg.id);
          const entry: TranscriptEntry = {
            sender,
            text: seg.text,
            isFinal: seg.final,
            id: seg.id,
          };
          if (idx >= 0) {
            this.transcript[idx] = entry;
          } else {
            this.transcript.push(entry);
          }
        }
        this.onTranscript?.(this.transcript);
      }
    );

    try {
      // Request mic permission explicitly before connecting
      // On mobile this forces the browser permission prompt from a user gesture
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop()); // release immediately
        console.log('[Voice] Mic permission granted');
      } catch (permErr: any) {
        console.error('[Voice] Mic permission denied:', permErr);
        this.micError = `Microphone blocked: ${permErr.message || permErr}. Check browser permissions.`;
      }

      await this.room.connect(url, token);
      this.isConnected = true;
      try {
        await this.room.localParticipant.setMicrophoneEnabled(true);
        this.isMicEnabled = true;
        this.micError = '';
      } catch (micErr: any) {
        console.error('[Voice] setMicrophoneEnabled failed:', micErr);
        this.isMicEnabled = false;
        this.micError = `Microphone failed: ${micErr.message || micErr}`;
      }
    } catch (e) {
      await this.disconnect();
      throw e;
    } finally {
      this.isConnecting = false;
    }
  }

  // Pending reviewer connection info — reviewer connects lazily after author speaks
  private pendingReviewerUrl = '';
  private pendingReviewerToken = '';
  private reviewerConnected = false;

  async connectDebate(
    authorUrl: string,
    authorToken: string,
    reviewerUrl: string,
    reviewerToken: string,
  ): Promise<void> {
    // Clean up any existing connections
    await this.disconnect();

    this.isConnecting = true;
    this.isConnected = false;
    this.isDebateMode = true;
    this.reviewerConnected = false;
    this.transcript = [];
    this.activeSpeaker = null;

    // Store reviewer credentials for lazy connect
    this.pendingReviewerUrl = reviewerUrl;
    this.pendingReviewerToken = reviewerToken;

    // Request mic permission once before connecting
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      console.log('[Voice] Mic permission granted for debate');
    } catch (permErr: any) {
      console.error('[Voice] Mic permission denied:', permErr);
      this.micError = `Microphone blocked: ${permErr.message || permErr}. Check browser permissions.`;
    }

    this.authorRoom = new Room();
    this.setupRoomHandlers(this.authorRoom, 'author', this.authorAudioElements);

    try {
      // Connect author room only — reviewer connects after author speaks
      await this.authorRoom.connect(authorUrl, authorToken);
      this.isConnected = true;

      try {
        await this.authorRoom.localParticipant.setMicrophoneEnabled(true);
        this.isMicEnabled = true;
        this.micError = '';
      } catch (micErr: any) {
        console.error('[Voice] setMicrophoneEnabled failed:', micErr);
        this.isMicEnabled = false;
        this.micError = `Microphone failed: ${micErr.message || micErr}`;
      }

      console.log('[Voice] Author room connected. Reviewer will connect after author speaks.');
    } catch (e) {
      await this.disconnect();
      throw e;
    } finally {
      this.isConnecting = false;
    }
  }

  async connectReviewerRoom(): Promise<void> {
    if (this.reviewerConnected || !this.pendingReviewerUrl) return;
    this.reviewerConnected = true;

    console.log('[Voice] Connecting reviewer room...');
    this.reviewerRoom = new Room();
    this.setupRoomHandlers(this.reviewerRoom, 'reviewer', this.reviewerAudioElements);

    try {
      await this.reviewerRoom.connect(this.pendingReviewerUrl, this.pendingReviewerToken);
      await this.reviewerRoom.localParticipant.setMicrophoneEnabled(true);
      console.log('[Voice] Reviewer room connected.');
    } catch (e) {
      console.error('[Voice] Reviewer room connection failed:', e);
      this.reviewerConnected = false;
    }
  }

  private setupRoomHandlers(
    room: Room,
    role: 'author' | 'reviewer',
    audioElements: HTMLElement[],
  ): void {
    const audioId = `lk-${role}-audio`;

    room.on(
      RoomEvent.TrackSubscribed,
      (track, _pub: RemoteTrackPublication, _participant: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.id = audioId;
          audioElements.push(el);
          this.applyPauseStateToElement(el);
          document.body.appendChild(el);
        }
      }
    );

    room.on(
      RoomEvent.TrackUnsubscribed,
      (track) => {
        track.detach().forEach((el) => {
          const index = audioElements.indexOf(el);
          if (index > -1) {
            audioElements.splice(index, 1);
          }
          el.remove();
        });
      }
    );

    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant, _kind?: DataPacket_Kind, topic?: string) => {
        const raw = new TextDecoder().decode(payload);
        console.log(`[VoiceService:${role}] DataReceived topic:`, topic, 'raw:', raw);
        if (topic !== 'client_actions') return;
        try {
          const msg = JSON.parse(raw);
          let action: any;
          if (msg.type === 'client_action' && msg.action) {
            action = { type: msg.action, payload: msg.payload };
          } else {
            action = msg;
          }
          // Tag action with role so the app knows which agent sent it
          action._debateRole = role;
          console.log(`[VoiceService:${role}] Forwarding action:`, action);
          this.onClientAction?.(action);
        } catch (e) {
          console.warn(`VoiceService:${role}: failed to parse data message`, e);
        }
      }
    );

    room.on(
      RoomEvent.TranscriptionReceived,
      (segments: TranscriptionSegment[], participant?: Participant) => {
        const isAgent = participant instanceof RemoteParticipant;
        const sender = isAgent ? 'agent' : 'you';
        for (const seg of segments) {
          const entryId = `${role}-${seg.id}`;
          const idx = this.transcript.findIndex((e) => e.id === entryId);
          const entry: TranscriptEntry = {
            sender,
            text: seg.text,
            isFinal: seg.final,
            id: entryId,
            role,
          };
          if (idx >= 0) {
            this.transcript[idx] = entry;
          } else {
            this.transcript.push(entry);
          }

          // Track active speaker
          if (isAgent && seg.text.length > 0) {
            this.activeSpeaker = role;
          }
        }
        this.onTranscript?.(this.transcript);
      }
    );
  }

  muteAgentAudio(role: 'author' | 'reviewer'): void {
    const elements = role === 'author' ? this.authorAudioElements : this.reviewerAudioElements;
    elements.forEach(el => {
      if (el instanceof HTMLMediaElement) {
        el.muted = true;
      } else {
        el.setAttribute('muted', 'true');
      }
    });
    console.log(`[Voice] Muted ${role} audio`);
  }

  unmuteAgentAudio(role: 'author' | 'reviewer'): void {
    const elements = role === 'author' ? this.authorAudioElements : this.reviewerAudioElements;
    elements.forEach(el => {
      if (el instanceof HTMLMediaElement) {
        el.muted = false;
      } else {
        el.removeAttribute('muted');
      }
    });
    console.log(`[Voice] Unmuted ${role} audio`);
  }

  /** Mute the student's mic in a specific agent's room so the agent stops hearing input */
  async muteLocalMicInRoom(role: 'author' | 'reviewer'): Promise<void> {
    const room = role === 'author' ? this.authorRoom : this.reviewerRoom;
    if (room?.localParticipant) {
      try {
        await room.localParticipant.setMicrophoneEnabled(false);
        console.log(`[Voice] Muted local mic in ${role} room`);
      } catch (e) {
        console.warn(`[Voice] Failed to mute mic in ${role} room:`, e);
      }
    }
  }

  /** Unmute the student's mic in a specific agent's room so the agent can hear again */
  async unmuteLocalMicInRoom(role: 'author' | 'reviewer'): Promise<void> {
    const room = role === 'author' ? this.authorRoom : this.reviewerRoom;
    if (room?.localParticipant) {
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        console.log(`[Voice] Unmuted local mic in ${role} room`);
      } catch (e) {
        console.warn(`[Voice] Failed to unmute mic in ${role} room:`, e);
      }
    }
  }

  async sendContextToRole(context: string, role: 'author' | 'reviewer'): Promise<void> {
    const targetRoom = role === 'author' ? this.authorRoom : this.reviewerRoom;
    if (!targetRoom?.localParticipant) return;

    const message = JSON.stringify({
      type: 'client_action',
      action: 'pdf_context',
      payload: { context },
    });
    const payload = new TextEncoder().encode(message);
    await targetRoom.localParticipant.publishData(payload, {
      reliable: true,
      topic: 'client_actions',
    });
  }

  async relayToAgent(targetRole: 'author' | 'reviewer', message: string): Promise<void> {
    const targetRoom = targetRole === 'author' ? this.authorRoom : this.reviewerRoom;
    if (!targetRoom?.localParticipant) return;

    const data = JSON.stringify({
      type: 'client_action',
      action: 'relay_message',
      payload: { message },
    });
    const payload = new TextEncoder().encode(data);
    await targetRoom.localParticipant.publishData(payload, {
      reliable: true,
      topic: 'client_actions',
    });
  }

  async disconnect(): Promise<void> {
    // Disconnect debate rooms
    if (this.authorRoom) {
      try { await this.authorRoom.disconnect(true); } catch (_) {}
      this.authorRoom = null;
    }
    if (this.reviewerRoom) {
      try { await this.reviewerRoom.disconnect(true); } catch (_) {}
      this.reviewerRoom = null;
    }
    this.authorAudioElements.forEach(el => el.remove());
    this.authorAudioElements = [];
    this.reviewerAudioElements.forEach(el => el.remove());
    this.reviewerAudioElements = [];

    // Disconnect tutor room
    if (this.room) {
      try {
        await this.room.disconnect(true);
      } catch (error) {
        console.error('Error disconnecting room:', error);
      }
      this.room = null;
    }
    // Remove all audio elements
    this.audioElements.forEach(el => el.remove());
    this.audioElements = [];
    // Fallback: remove by ID
    for (const id of ['lk-agent-audio', 'lk-author-audio', 'lk-reviewer-audio']) {
      const audioEl = document.getElementById(id);
      if (audioEl) audioEl.remove();
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.isMicEnabled = false;
    this.isPaused = false;
    this.isDebateMode = false;
    this.activeSpeaker = null;
    this.transcript = [];
  }

  async toggleMic(): Promise<void> {
    if (this.isDebateMode) {
      const next = !this.isMicEnabled;
      const promises: Promise<any>[] = [];
      if (this.authorRoom) {
        promises.push(this.authorRoom.localParticipant.setMicrophoneEnabled(next));
      }
      if (this.reviewerRoom) {
        promises.push(this.reviewerRoom.localParticipant.setMicrophoneEnabled(next));
      }
      await Promise.all(promises);
      this.isMicEnabled = next;
      return;
    }

    if (!this.room) return;
    const next = !this.isMicEnabled;
    await this.room.localParticipant.setMicrophoneEnabled(next);
    this.isMicEnabled = next;
  }

  private applyPauseStateToElement(el: HTMLElement): void {
    // Try multiple ways to mute/pause the audio element
    if (el instanceof HTMLAudioElement || el instanceof HTMLMediaElement) {
      el.muted = this.isPaused;
      if (this.isPaused) {
        el.pause();
      } else {
        el.play().catch(err => console.warn('Could not play audio:', err));
      }
    } else {
      // For other element types, try setting muted attribute
      if (this.isPaused) {
        el.setAttribute('muted', 'true');
        (el as any).pause?.();
      } else {
        el.removeAttribute('muted');
        (el as any).play?.().catch((err: any) => console.warn('Could not play audio:', err));
      }
    }
  }

  async togglePause(): Promise<void> {
    if (this.isDebateMode) {
      return this.togglePauseDebate();
    }

    if (!this.room || !this.isConnected) {
      console.warn('Cannot pause: room not connected');
      return;
    }

    try {
      this.isPaused = !this.isPaused;

      // Mute mic when paused
      if (this.room.localParticipant) {
        await this.room.localParticipant.setMicrophoneEnabled(!this.isPaused);
        this.isMicEnabled = !this.isPaused;
      }

      // Mute/pause all agent audio elements
      if (this.audioElements.length > 0) {
        this.audioElements.forEach(el => {
          this.applyPauseStateToElement(el);
        });
        console.log(`Applied pause state (${this.isPaused}) to ${this.audioElements.length} audio element(s)`);
      } else {
        // Fallback: try to find by ID
        const audioEl = document.getElementById('lk-agent-audio');
        if (audioEl) {
          this.audioElements.push(audioEl);
          this.applyPauseStateToElement(audioEl);
        } else {
          console.warn('No audio elements found for muting');
        }
      }
    } catch (error) {
      console.error('Error toggling pause:', error);
      // Revert state on error
      this.isPaused = !this.isPaused;
      throw error;
    }
  }

  private async togglePauseDebate(): Promise<void> {
    if (!this.isConnected) {
      console.warn('Cannot pause debate: not connected');
      return;
    }

    try {
      this.isPaused = !this.isPaused;

      // Mute mic on both rooms
      const micPromises: Promise<any>[] = [];
      if (this.authorRoom?.localParticipant) {
        micPromises.push(this.authorRoom.localParticipant.setMicrophoneEnabled(!this.isPaused));
      }
      if (this.reviewerRoom?.localParticipant) {
        micPromises.push(this.reviewerRoom.localParticipant.setMicrophoneEnabled(!this.isPaused));
      }
      await Promise.all(micPromises);
      this.isMicEnabled = !this.isPaused;

      // Mute/pause all debate audio elements
      const allAudio = [...this.authorAudioElements, ...this.reviewerAudioElements];
      allAudio.forEach(el => this.applyPauseStateToElement(el));
      console.log(`Applied debate pause state (${this.isPaused}) to ${allAudio.length} audio element(s)`);
    } catch (error) {
      console.error('Error toggling debate pause:', error);
      this.isPaused = !this.isPaused;
      throw error;
    }
  }

  async publishData(data: any, topic = 'agent_results'): Promise<void> {
    if (this.isDebateMode) {
      // Publish to both rooms in debate mode
      const payload = new TextEncoder().encode(JSON.stringify(data));
      const promises: Promise<void>[] = [];
      if (this.authorRoom?.localParticipant) {
        promises.push(this.authorRoom.localParticipant.publishData(payload, { topic }));
      }
      if (this.reviewerRoom?.localParticipant) {
        promises.push(this.reviewerRoom.localParticipant.publishData(payload, { topic }));
      }
      await Promise.all(promises);
      return;
    }

    if (!this.room?.localParticipant) return;
    const payload = new TextEncoder().encode(JSON.stringify(data));
    await this.room.localParticipant.publishData(payload, { topic });
  }

  async sendData(data: any): Promise<void> {
    await this.publishData(data, 'paper_navigation');
  }

  async sendContext(context: string): Promise<void> {
    if (this.isDebateMode) {
      // In debate mode, send context to both rooms
      await Promise.all([
        this.sendContextToRole(context, 'author'),
        this.sendContextToRole(context, 'reviewer'),
      ]);
      return;
    }

    if (!this.room?.localParticipant) return;
    // Send PDF context as a client_action data message so the agent receives it
    const message = JSON.stringify({
      type: 'client_action',
      action: 'pdf_context',
      payload: { context },
    });
    const payload = new TextEncoder().encode(message);
    await this.room.localParticipant.publishData(payload, {
      reliable: true,
      topic: 'client_actions',
    });
  }

  setClientActionHandler(handler: (action: any) => void): void {
    this.onClientAction = handler;
  }

  setTranscriptHandler(handler: (transcript: TranscriptEntry[]) => void): void {
    this.onTranscript = handler;
  }
}
