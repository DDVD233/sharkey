/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Normalizes a language tag to the short form used for matching. Region is stripped and all
 * Chinese variants (zh-CN / zh-TW / zh-Hant …) collapse to `zh`.
 */
export function normalizeLang(lang: string | null | undefined): string | null {
	if (lang == null) return null;
	const base = lang.toLowerCase().trim().split(/[-_]/)[0];
	if (base === '') return null;
	if (base === 'zh') return 'zh';
	return base;
}
