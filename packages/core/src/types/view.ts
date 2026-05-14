import type { AppLifecycleState } from './lifecycle.js';

/** Display state of an AppView within the layout. */
export type ViewState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

/**
 * A visible UI tile in the OS layout. Always bound to a backend `instanceId` and
 * (when the app declares `activityMode='multi'`) to an `activityId` that identifies
 * which UI screen of that instance this tile shows.
 *
 * Android analogy: an AppView is one Surface/Window on screen, an Activity is the
 * thing that owns it.
 */
export interface AppView {
  viewId: string;
  appId: string;
  /** Backend instance this view is bound to. */
  instanceId: string;
  /** Optional activity (Android-style UI screen) on top of the instance, when activityMode='multi'. */
  activityId?: string;
  title: string;
  iframeUrl: string;
  state: ViewState;
  zIndex: number;
  isFocused: boolean;
  isLoading: boolean;
  lifecycleState: AppLifecycleState;
  createdAt: string;
}
