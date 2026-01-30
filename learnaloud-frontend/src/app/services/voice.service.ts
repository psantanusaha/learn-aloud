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

  async disconnect(): Promise<void> {
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
    const audioEl = document.getElementById('lk-agent-audio');
    if (audioEl) {
      audioEl.remove();
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.isMicEnabled = false;
    this.isPaused = false;
    this.transcript = [];
  }

  async toggleMic(): Promise<void> {
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

  async publishData(data: any, topic = 'agent_results'): Promise<void> {
    if (!this.room?.localParticipant) return;
    const payload = new TextEncoder().encode(JSON.stringify(data));
    await this.room.localParticipant.publishData(payload, { topic });
  }

  async sendData(data: any): Promise<void> {
    await this.publishData(data, 'paper_navigation');
  }

  async sendContext(context: string): Promise<void> {
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
