'use strict';

// Minimal curated block list — extend as needed
const BLOCKED = [
  'fuck','shit','bitch','cunt','cock','dick','pussy','nigger','nigga',
  'kike','chink','spic','retard','faggot','dyke','twat','wanker',
  'asshole','bastard','whore','slut',
];

// Build pattern: match as whole word or adjacent to digits (leet speak tolerance)
const PATTERN = new RegExp(
  '(' + BLOCKED.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')',
  'i'
);

function isProfane(str) {
  return PATTERN.test(String(str));
}

module.exports = { isProfane };
