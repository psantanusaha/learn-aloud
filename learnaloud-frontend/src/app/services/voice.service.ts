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

  transcript: TranscriptEntry[] = [];
  isConnected = false;
  isConnecting = false;
  isMicEnabled = true;

  async connect(url: string, token: string): Promise<void> {
    if (this.room) {
      await this.disconnect();
    }

    this.isConnecting = true;
    this.room = new Room();

    this.room.on(
      RoomEvent.TrackSubscribed,
      (track, _pub: RemoteTrackPublication, _participant: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.id = 'lk-agent-audio';
          document.body.appendChild(el);
        }
      }
    );

    this.room.on(
      RoomEvent.TrackUnsubscribed,
      (track) => {
        track.detach().forEach((el) => el.remove());
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
      await this.room.connect(url, token);
      this.isConnected = true;
      try {
        await this.room.localParticipant.setMicrophoneEnabled(true);
        this.isMicEnabled = true;
      } catch (micErr) {
        console.warn('Microphone access denied or failed:', micErr);
        this.isMicEnabled = false;
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
      await this.room.disconnect(true);
      this.room = null;
    }
    document.getElementById('lk-agent-audio')?.remove();
    this.isConnected = false;
    this.isConnecting = false;
    this.isMicEnabled = false;
    this.transcript = [];
  }

  async toggleMic(): Promise<void> {
    if (!this.room) return;
    const next = !this.isMicEnabled;
    await this.room.localParticipant.setMicrophoneEnabled(next);
    this.isMicEnabled = next;
  }

  setClientActionHandler(handler: (action: any) => void): void {
    this.onClientAction = handler;
  }

  setTranscriptHandler(handler: (transcript: TranscriptEntry[]) => void): void {
    this.onTranscript = handler;
  }
}
