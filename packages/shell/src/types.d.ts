declare interface Window {
  /**
   * Launch an app. For activityMode='multi' apps, every call may open a new
   * activity view (depending on manifest.defaultLaunch); otherwise focuses
   * an existing view or starts a new instance.
   */
  auraLaunchApp: (appId: string) => Promise<void>;
  /** Close a view by its viewId (id is opaque from the caller's view). */
  auraClose: (viewId: string) => void;
  /** Minimize a view by its viewId. */
  auraMinimize: (viewId: string) => void;
}
