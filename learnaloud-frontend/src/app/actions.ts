export interface Action {
  type: 'HIGHLIGHT_TEXT' | 'HIGHLIGHT_REGION' | 'NAVIGATE' | 'SHOW_CARD' | 'SCROLL_TO' | 'NAVIGATE_TO_PAGE';
  payload: any;
}

export interface NavigateToPagePayload {
  page: number;
  sessionId?: string;
}

export interface HighlightTextPayload {
  text: string;
  color: string;
  page: number;
  sessionId?: string;
}

export interface HighlightRegionPayload {
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
  color: string;
  sessionId?: string;
}

export interface NavigatePayload {
  url?: string;
  route?: string;
}

export interface ShowCardPayload {
  title: string;
  content: string;
  image?: string;
}

export interface ScrollToPayload {
  elementId: string;
}
