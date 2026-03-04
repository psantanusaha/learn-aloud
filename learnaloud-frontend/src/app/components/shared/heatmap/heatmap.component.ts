import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';

export type HeatmapVariant = 'strip' | 'full';

export interface HeatmapSection {
  id: string;
  label?: string;
  coverage: number; // 0-100
  depth: number; // 0-100
}

@Component({
  selector: 'la-heatmap',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './heatmap.component.html',
  styleUrl: './heatmap.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HeatmapComponent {
  @Input() sections: HeatmapSection[] = [];
  @Input() variant: HeatmapVariant = 'strip';

  get isStrip(): boolean {
    return this.variant === 'strip';
  }

  get isFull(): boolean {
    return this.variant === 'full';
  }

  /**
   * For strip variant: generate 12 segments from sections data
   */
  get stripSegments(): number[] {
    if (this.sections.length === 0) {
      return Array(12).fill(0);
    }

    const segments: number[] = [];
    const segmentCount = 12;
    const sectionsPerSegment = Math.ceil(this.sections.length / segmentCount);

    for (let i = 0; i < segmentCount; i++) {
      const startIdx = i * sectionsPerSegment;
      const endIdx = Math.min(startIdx + sectionsPerSegment, this.sections.length);
      const segmentSections = this.sections.slice(startIdx, endIdx);

      if (segmentSections.length === 0) {
        segments.push(0);
      } else {
        // Average coverage weighted by depth
        const avgCoverage =
          segmentSections.reduce((sum, s) => sum + s.coverage, 0) / segmentSections.length;
        segments.push(avgCoverage);
      }
    }

    return segments;
  }

  getSegmentColor(value: number): string {
    // 0 = no coverage (dark), 100 = full coverage (amber)
    if (value === 0) return 'var(--ink-60)';
    if (value < 30) return 'rgba(232, 164, 39, 0.3)';
    if (value < 60) return 'rgba(232, 164, 39, 0.6)';
    return 'var(--amber)';
  }

  getDepthColor(depth: number): string {
    // Depth shown as teal intensity
    if (depth === 0) return 'var(--ink-60)';
    if (depth < 30) return 'rgba(20, 184, 166, 0.3)';
    if (depth < 60) return 'rgba(20, 184, 166, 0.6)';
    return 'var(--teal)';
  }

  trackBySectionId(index: number, section: HeatmapSection): string {
    return section.id;
  }
}
