#!/usr/bin/env python3
# SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""
Bucket the spam classifier's false negatives (gold=spam, predicted=ham) into
'real miss' vs 'acceptable / dataset-noise', per instance policy:

  - Deliberate obfuscation/evasion OR commercial contact-solicitation -> REAL MISS
    (the evasion / "go to my profile for contact" intent is the spam signal)
  - Plain adult chatter, profanity, flooding/keysmash, normal talk      -> NOT our spam
    (this dataset is Chinese livestream-chat moderation data, much broader
     than our commercial/phishing definition, so much of label=1 is out of scope)

Heuristics are intentionally HIGH-PRECISION (conservative): a row only counts
as a real miss on a strong signal, so the 'real miss' count is a lower bound.

Reads a *_misses_raw.tsv (confidence<TAB>pred_label<TAB>text).
"""
import sys, re
from collections import Counter

INFILE = sys.argv[1] if len(sys.argv) > 1 else "eval/out/all_misses_raw.tsv"

def has_obfuscation(t: str) -> bool:
    for ch in t:
        o = ord(ch)
        if 0x1D400 <= o <= 0x1D7FF:                       # math alphanumerics 𝐇𝕌𝐗
            return True
        if 0x16A0 <= o <= 0x16FF:                         # runic ᚰ filler
            return True
        if 0xFF21 <= o <= 0xFF3A or 0xFF41 <= o <= 0xFF5A:  # FULLWIDTH LETTERS ＴＡＤ (not punct!)
            return True
        if 0xFF10 <= o <= 0xFF19:                         # fullwidth digits ７６５
            return True
        if o in (0x200B, 0x200C, 0x200D):                 # zero-width
            return True
    # digits deliberately split by symbols to dodge a number filter: 4➕5➕1➕0, 2◐48 78
    if re.search(r"\d[\s\+\-\.•·●◐☀☎❤♥➕]{1,3}\d", t):
        return True
    return False

# "check my profile name / look at the name for the goods" — the signature solicitation
# pattern in this dataset (porn/contact pimping that points off-text to a handle).
PROFILE_SOLICIT = re.compile(r"(看|注意).{0,4}(网名|名字|我名|的名|昵称)|名字.{0,3}(看|加|私|篇)|看.{0,2}篇")
CONTACT_KW = re.compile(r"(微信|薇信|徾信|加微|企鹅|扣扣|抠抠|扣号|抠号|QQ号|q号|私聊|代理|招代理|信誉|担保)")

def has_contact(t: str) -> bool:
    if PROFILE_SOLICIT.search(t) or CONTACT_KW.search(t):
        return True
    if re.search(r"\d{5,}", t):                           # a bare 5+ digit run = QQ/phone id
        return True
    return False

rows = []
for line in open(INFILE):
    p = line.rstrip("\n").split("\t")
    if len(p) < 3 or p[0] == "confidence":
        continue
    rows.append((float(p[0]), p[2]))

buckets = Counter()
examples = {k: [] for k in ["contact_solicit", "obfuscation", "out_of_scope"]}
for conf, text in rows:
    if has_contact(text):
        cat = "contact_solicit"      # REAL MISS
    elif has_obfuscation(text):
        cat = "obfuscation"          # REAL MISS
    else:
        cat = "out_of_scope"         # chatter / profanity / flood / plain adult — not our spam
    buckets[cat] += 1
    if len(examples[cat]) < 16:
        examples[cat].append((conf, text))

total = len(rows)
real = buckets["contact_solicit"] + buckets["obfuscation"]
labels = {
    "contact_solicit": "REAL MISS · contact-solicitation (profile/QQ/WeChat/id)",
    "obfuscation":     "REAL MISS · unicode obfuscation / split-digit evasion",
    "out_of_scope":    "OUT OF SCOPE · chatter/profanity/flood/plain adult",
}
print(f"false negatives analyzed: {total}\n")
for k in ["contact_solicit", "obfuscation", "out_of_scope"]:
    print(f"  {labels[k]:56} {buckets[k]:5}  ({100*buckets[k]/total:.1f}%)")
print(f"\n  => REAL misses (lower bound, high-precision signals): {real}  ({100*real/total:.1f}% of FNs)")
print(f"  => out-of-scope / dataset noise:                      {buckets['out_of_scope']}  ({100*buckets['out_of_scope']/total:.1f}%)\n")
for k in ["contact_solicit", "obfuscation", "out_of_scope"]:
    print(f"--- {labels[k]} ---")
    for conf, text in examples[k]:
        print(f"   {conf:.3f}  {text[:70]}")
    print()
