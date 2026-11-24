/**
 * Who may read a KV namespace: `os` is readable by every app, `app/<id>` only
 * by that app. The KV route and the App Host event view both ask here, so a
 * value can't reach a caller over the event stream that the route would refuse.
 */
export const kvReadAllowed = (namespace: string, callerAppId: string): boolean =>
  namespace === 'os' || namespace === `app/${callerAppId}`;
