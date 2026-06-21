/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Lightweight haptic feedback for interactive controls (reply / boost / react …).
//
// Android (Chrome/Firefox/etc.) exposes the Vibration API, so we drive it directly.
// iOS Safari does NOT implement `navigator.vibrate`, but since 17.4 it fires the
// system Taptic engine when a `<label>`-wrapped `<input switch>` is toggled. We lazily
// build one hidden control and "click" it as a best-effort fallback. Anything else is a
// silent no-op — haptics are a progressive enhancement and must never throw.

export type HapticPattern = 'tap' | 'success' | 'warning';

// Durations are deliberately on the longer side: most Android vibration motors
// (especially ERM) need ~15ms+ to spin up enough to be felt, so sub-10ms pulses
// register as nothing. A single solid pulse reads more clearly than rapid bursts.
const VIBRATION_PATTERNS: Record<HapticPattern, number | number[]> = {
	tap: 18,
	success: 40,
	warning: [35, 50, 35],
};

let iosSwitchLabel: HTMLLabelElement | null = null;

function canVibrate(): boolean {
	return typeof window !== 'undefined' && typeof window.navigator.vibrate === 'function';
}

function getIosSwitchLabel(): HTMLLabelElement | null {
	if (typeof window === 'undefined') return null;
	if (iosSwitchLabel != null) return iosSwitchLabel;

	const label = window.document.createElement('label');
	label.ariaHidden = 'true';
	label.style.display = 'none';

	const input = window.document.createElement('input');
	input.type = 'checkbox';
	// `switch` is the iOS Safari attribute that turns a checkbox into a haptic toggle.
	input.setAttribute('switch', '');
	input.tabIndex = -1;

	label.appendChild(input);
	window.document.head.appendChild(label);

	iosSwitchLabel = label;
	return label;
}

/**
 * Trigger a short haptic pulse, if the platform supports it.
 * Safe to call unconditionally — unsupported platforms simply do nothing.
 */
export function haptic(pattern: HapticPattern = 'tap'): void {
	try {
		if (canVibrate()) {
			window.navigator.vibrate(VIBRATION_PATTERNS[pattern]);
			return;
		}

		// iOS fallback: toggling the hidden switch nudges the Taptic engine.
		getIosSwitchLabel()?.click();
	} catch {
		// Never let haptics break an interaction.
	}
}
