/**
 * The scope and home selector (D107): which home environment the app runs
 * with, and whether its instance is per user or shared.
 *
 *   App Home      the app's own isolated, persistent home: the secure default
 *   Private Home  your personal home, permanently: your logins, tools and
 *                 configuration. It needs YOUR approval (`home.private`,
 *                 with your password); the app's declaration never grants it
 *   per-user      an instance of your own
 *   shared        one instance for several users: arrives with multi-user
 *                 (BT-M2), shown unavailable, never selectable in the alpha
 *
 * Desired is not authorized (D107): the selection is what the owner wants;
 * whether `home.private` counts is shown, never assumed, and a missing grant
 * never turns Private into App Home here or anywhere.
 */
import type { HomeEnvironment, HomeEnvironmentsDeclaration, InstanceScope, SetupErrorBody } from '@aura/core';
import { el, reasonList, section } from './dom.js';

export interface HomeSelectorProps {
  /** The app's declaration (manifest `homeEnvironments`); absent: App Home only. */
  declared?: HomeEnvironmentsDeclaration;
  /** The desired home (the record or this run); null: not chosen yet. */
  home: HomeEnvironment | null;
  /** Can Private Home be chosen here (policy `app-private-home`, runtime feature, profile)? With the D105 reasons when not. */
  privateAvailable: boolean;
  privateReasons?: readonly SetupErrorBody[];
  /** Does the `home.private` grant already count for this installation and user? */
  privateAuthorized?: boolean;
  /** The desired instance scope; null: not chosen yet. */
  instanceScope: InstanceScope | null;
  disabled?: boolean;
}

export interface HomeSelectorCallbacks {
  onHome(home: HomeEnvironment): void;
  onInstanceScope(scope: InstanceScope): void;
}

export const HOME_TEXT: Readonly<Record<HomeEnvironment, { title: string; text: string }>> = Object.freeze({
  app: {
    title: 'App Home',
    text: 'The app keeps its own isolated, persistent home with its own logins and configuration. It cannot see your personal home. The secure default.',
  },
  private: {
    title: 'Private Home',
    text: 'The app can continuously use your personal home, including the credentials, logins and configuration in it, across restarts and updates. '
      + 'This needs your own approval with your password, and you can revoke it at any time: the app then stops until you approve again or choose App Home.',
  },
});

export const SHARED_SCOPE_UNAVAILABLE = 'Shared instances arrive with multi-user support.';

export function renderHomeSelector(root: HTMLElement, props: HomeSelectorProps, on: HomeSelectorCallbacks): void {
  const doc = root.ownerDocument;
  root.replaceChildren();

  const home = section(doc, 'home', 'Home environment');
  const supported = props.declared?.supported ?? ['app'];
  if (props.declared?.reason) home.append(el(doc, 'p', 'su-note', `The app says: ${props.declared.reason}`));
  const homes = el(doc, 'div', 'su-options');
  homes.setAttribute('role', 'radiogroup');
  for (const env of ['app', 'private'] as const) {
    const declared = supported.includes(env);
    const ok = declared && (env === 'app' || props.privateAvailable);
    const opt = el(doc, 'label', ok ? 'su-option' : 'su-option su-unavailable');
    opt.dataset['home'] = env;
    opt.dataset['available'] = String(ok);
    const radio = el(doc, 'input');
    radio.type = 'radio';
    radio.name = 'su-home';
    radio.value = env;
    radio.disabled = !ok || props.disabled === true;
    radio.checked = ok && props.home === env;
    radio.addEventListener('change', () => { if (radio.checked && ok) on.onHome(env); });
    const head = el(doc, 'span', 'su-option-title', HOME_TEXT[env].title);
    if (props.declared?.recommended === env) head.append(' ', el(doc, 'span', 'su-badge', 'recommended by the app'));
    opt.append(radio, head, el(doc, 'span', 'su-option-desc', HOME_TEXT[env].text));
    if (env === 'private') {
      if (!declared) opt.append(el(doc, 'span', 'su-option-desc su-no', 'This app does not support the Private Home.'));
      else if (!props.privateAvailable && props.privateReasons?.length) opt.append(reasonList(doc, props.privateReasons));
      else if (ok) {
        const grant = el(doc, 'span', 'su-option-desc', props.privateAuthorized
          ? 'You have approved it for this app.'
          : 'Not approved yet: AuraOS asks for your approval when you apply.');
        grant.dataset['privateAuthorized'] = String(props.privateAuthorized === true);
        opt.append(grant);
      }
    }
    homes.append(opt);
  }
  home.append(homes);

  const scope = section(doc, 'instance-scope', 'Instance');
  const scopes = el(doc, 'div', 'su-options');
  scopes.setAttribute('role', 'radiogroup');
  const scopeText: Record<InstanceScope, [string, string]> = {
    'per-user': ['Your own instance', 'A dedicated instance that belongs to you.'],
    shared: ['Shared instance', SHARED_SCOPE_UNAVAILABLE],
  };
  for (const sc of ['per-user', 'shared'] as const) {
    const ok = sc === 'per-user';
    const opt = el(doc, 'label', ok ? 'su-option' : 'su-option su-unavailable');
    opt.dataset['instanceScope'] = sc;
    opt.dataset['available'] = String(ok);
    const radio = el(doc, 'input');
    radio.type = 'radio';
    radio.name = 'su-instance-scope';
    radio.value = sc;
    radio.disabled = !ok || props.disabled === true;
    radio.checked = ok && props.instanceScope === sc;
    radio.addEventListener('change', () => { if (radio.checked && ok) on.onInstanceScope(sc); });
    opt.append(radio, el(doc, 'span', 'su-option-title', scopeText[sc][0]), el(doc, 'span', ok ? 'su-option-desc' : 'su-option-desc su-no', scopeText[sc][1]));
    scopes.append(opt);
  }
  scope.append(scopes);
  root.append(home, scope);
}
