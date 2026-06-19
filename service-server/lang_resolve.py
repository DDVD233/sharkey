# SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Single source of truth for note-language resolution, MIRRORING the TypeScript
# implementation in packages/backend/src/core/LanguageDetectionService.ts
# (resolveNoteLang + the DEFAULT_* constants). Keep the two in sync: any change to
# thresholds, the trusted set, or the CJK rule must be made in both places.

# Languages that make up >95% of real posts. Anything outside this set is
# overwhelmingly a short-text misdetection, so we distrust it much harder.
DEFAULT_TRUSTED_LANGS = frozenset({"zh", "ja", "en", "es", "ru"})

# CJK languages lingua confuses on short text (e.g. a Japanese "草" detected as zh
# at high confidence). Corrected against the author's inferred language.
CJK_LANGS = frozenset({"ja", "zh", "ko", "yue", "wuu", "nan"})

# Calibrated on ~8k real notes: trusted<0.30 + untrusted<0.85 corrects ~12.5% of notes.
DEFAULT_MIN_CONFIDENCE = 0.30
DEFAULT_MIN_CONFIDENCE_UNTRUSTED = 0.85
DEFAULT_MIN_NOTES_FOR_INFERRED = 5

# How many of the user's most recent notes to consider when inferring their language.
INFERRED_LANG_WINDOW = 100


def resolve_note_lang(
    raw_lang,
    confidence,
    user_inferred_lang,
    trusted_langs=DEFAULT_TRUSTED_LANGS,
    min_confidence=DEFAULT_MIN_CONFIDENCE,
    min_confidence_untrusted=DEFAULT_MIN_CONFIDENCE_UNTRUSTED,
    cjk_cross_correct=True,
):
    """Resolve a note's stored language. Mirrors resolveNoteLang() in TypeScript."""
    if raw_lang is None:
        return user_inferred_lang

    if (cjk_cross_correct and user_inferred_lang is not None
            and user_inferred_lang != raw_lang
            and raw_lang in CJK_LANGS and user_inferred_lang in CJK_LANGS):
        return user_inferred_lang

    threshold = min_confidence if raw_lang in trusted_langs else min_confidence_untrusted
    if (confidence or 0.0) < threshold:
        return user_inferred_lang if user_inferred_lang is not None else raw_lang

    return raw_lang
