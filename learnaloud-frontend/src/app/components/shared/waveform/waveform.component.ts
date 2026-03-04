import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

export type WaveformColor = 'amber' | 'green';

@Component({
  selector: 'la-waveform',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './waveform.component.html',
  styleUrl: './waveform.component.css',
})
export class WaveformComponent implements OnInit {
  @Input() bars = 10;
  @Input() color: WaveformColor = 'amber';
  @Input() animated = false;

  barArray: number[] = [];

  ngOnInit(): void {
    this.barArray = Array.from({ length: this.bars }, (_, i) => i);
  }

  get containerClasses(): string {
    return [
      'la-waveform',
      `la-waveform--${this.color}`,
      this.animated ? 'la-waveform--animated' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  getBarHeight(index: number): number {
    const heights = [35, 70, 90, 55, 80, 100, 65, 45, 75, 50, 85, 40];
    return heights[index % heights.length];
  }

  getAnimationDelay(index: number): string {
    return `${index * 0.07}s`;
  }
}
