export type LayoutMode = 'fullscreen' | 'tiling' | 'windowed' | 'side-by-side' | 'pip';

export interface LayoutConfig {
  mode: LayoutMode;
  primaryWindowId?: string;
}
