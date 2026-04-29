const SELF_CONTRADICTING_COMPLETION_RE =
  /\b(?:blocked from completing|could not (?:complete|find|fulfill|verify|confirm|locate|access|extract|retrieve)|cannot (?:truthfully )?(?:provide|verify|confirm|complete|extract|retrieve)|not (?:visible|available|found|present|accessible|displayed|shown|confirmed|verified|reached|currently reachable)|did not (?:take effect|work|succeed|load|return|answer)|does not (?:answer|show|include|contain|provide)|unable to (?:fully )?(?:find|complete|verify|access|extract|retrieve)|no (?:visible (?:answer|result|data|content)|results? (?:found|returned|available))|(?:failed|failure) to (?:find|complete|set|select|navigate)|unfortunately|I (?:was|am) unable|I do not (?:yet )?have|not for the requested|not the requested|specific requested|requested [^.\n]*(?:date|dates?|results?|flight|fare|search)[^.\n]*(?:not|no)[^.\n]*(?:visible|reached|available|confirmed|retrieved)|exact requested .* not|(?:task|request|goal) (?:is|was) (?:not |in)complete)\b/i;

export function containsSelfContradictingCompletion(text: string): boolean {
  return SELF_CONTRADICTING_COMPLETION_RE.test(text);
}
