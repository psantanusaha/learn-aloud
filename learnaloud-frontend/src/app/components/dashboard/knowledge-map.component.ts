import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ConceptNode } from '../../models/knowledge.model';

interface NodePosition {
  concept: ConceptNode;
  x: number;
  y: number;
  r: number;
}

@Component({
  selector: 'app-knowledge-map',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './knowledge-map.component.html',
  styleUrls: ['./knowledge-map.component.css'],
})
export class KnowledgeMapComponent implements OnChanges {
  @Input() concepts: ConceptNode[] = [];

  nodes: NodePosition[] = [];
  edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
  selectedNode: ConceptNode | null = null;

  readonly width = 600;
  readonly height = 400;
  readonly cx = 300;
  readonly cy = 200;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['concepts']) {
      this.layout();
    }
  }

  selectNode(concept: ConceptNode): void {
    this.selectedNode = this.selectedNode?.id === concept.id ? null : concept;
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

  nodeRadius(mastery: number): number {
    return 20 + (mastery / 100) * 20; // 20-40px
  }

  private layout(): void {
    this.nodes = [];
    this.edges = [];
    if (!this.concepts.length) return;

    const count = this.concepts.length;
    const angleStep = (2 * Math.PI) / count;
    const baseRadius = Math.min(this.cx, this.cy) - 60;

    for (let i = 0; i < count; i++) {
      const c = this.concepts[i];
      const angle = angleStep * i - Math.PI / 2;
      const r = this.nodeRadius(c.mastery);
      const dist = count === 1 ? 0 : baseRadius;
      this.nodes.push({
        concept: c,
        x: this.cx + dist * Math.cos(angle),
        y: this.cy + dist * Math.sin(angle),
        r,
      });
    }

    // Build edges from relatedConcepts
    const posMap = new Map<string, NodePosition>();
    for (const n of this.nodes) posMap.set(n.concept.id, n);

    const edgeSet = new Set<string>();
    for (const n of this.nodes) {
      for (const relId of n.concept.relatedConcepts) {
        const rel = posMap.get(relId);
        if (!rel) continue;
        const key = [n.concept.id, relId].sort().join('-');
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        this.edges.push({ x1: n.x, y1: n.y, x2: rel.x, y2: rel.y });
      }
    }
  }
}
