/**
 * AutoscrollCheckbox — scificn `Checkbox` visually, with a hidden native
 * `<input type="checkbox" id="autoscroll">` so the existing vanilla Console JS
 * can keep reading `autoscroll.checked` + listening for `'change'` events
 * unchanged.
 *
 * Radix's CheckboxPrimitive renders a `<button role="checkbox">`, which:
 *   - lacks a `.checked` property, and
 *   - fires `onCheckedChange` instead of native `change` events.
 *
 * Rather than rewrite ~200 lines of legacy console JS, we just keep an
 * invisible native input on the side and dispatch `change` events to it
 * when the Radix state flips. That way the legacy contract is preserved
 * exactly.
 */
import * as React from 'react';
import { Checkbox } from '@aura/ui';

export interface AutoscrollCheckboxProps {
  /** id of the hidden native shim input (legacy JS contract: `document.getElementById('autoscroll').checked`). */
  id?: string;
  defaultChecked?: boolean;
  /** Optional visible label rendered by scificn's Checkbox itself. */
  label?: string;
}

export function AutoscrollCheckbox({
  id = 'autoscroll',
  defaultChecked = true,
  label,
}: AutoscrollCheckboxProps): React.JSX.Element {
  const [checked, setChecked] = React.useState<boolean>(defaultChecked);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Legacy contract: `document.getElementById(id).checked` and a `change`
  // event on the same node. The shim keeps the requested id; the visible Radix
  // checkbox gets a suffixed id so a wrapping <label for={id}> (or any other
  // form binding to the legacy id) doesn't redirect clicks to the
  // pointer-events:none shim and silently swallow them.
  const visibleId = `${id}-visible`;

  function handleChange(next: boolean | 'indeterminate'): void {
    const isChecked = next === true;
    setChecked(isChecked);
    if (inputRef.current) {
      inputRef.current.checked = isChecked;
      // Fire a native change event so vanilla listeners (registered via
      // `autoscroll.addEventListener('change', …)`) keep firing.
      inputRef.current.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="checkbox"
        id={id}
        defaultChecked={defaultChecked}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
        tabIndex={-1}
        aria-hidden="true"
        readOnly
      />
      <Checkbox id={visibleId} label={label} checked={checked} onCheckedChange={handleChange} />
    </>
  );
}

export default AutoscrollCheckbox;
