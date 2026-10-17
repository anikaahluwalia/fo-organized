/**
 * Explainable request-risk signals. These are heuristics: they point at things a person should
 * look at. They never conclude that a requester is legitimate or fraudulent.
 */

export type SignalLevel = "warning" | "info";

export interface RiskSignal {
  id: string;
  level: SignalLevel;
  title: string;
  detail: string;
  evidence: string[];
}

export interface RiskAssessment {
  signals: RiskSignal[];
  hasWarnings: boolean;
  /** Headline to show. Never "safe", never "scam". */
  summary: string;
  baseline: { domain: string | null; source: string | null };
  requesterDomain: string | null;
}

export const CLEAN_SUMMARY = "No configured warning signs found; requester not verified.";
export const HOLD_SUMMARY = "Needs review: sharing on hold.";

const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "aol.com", "proton.me", "protonmail.com"]);

export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/^.*@/, "").replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

function matchesBaseline(host: string, baseline: string): boolean {
  return host === baseline || host.endsWith(`.${baseline}`);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

function skeleton(domain: string): string {
  return domain
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/0/g, "o")
    .replace(/[1|]/g, "l")
    .replace(/3/g, "e")
    .replace(/5/g, "s")
    .replace(/-/g, "");
}

/** Describes how `host` imitates `baseline`, or null if it doesn't look like an imitation. */
export function lookalikeReason(host: string, baseline: string): string | null {
  if (matchesBaseline(host, baseline)) return null;
  if (skeleton(host) === skeleton(baseline)) return `swaps look-alike characters (for example 1 for l or 0 for o) in ${baseline}`;
  if (levenshtein(host, baseline) <= 2) return `is a near-miss spelling of ${baseline}`;
  const name = skeleton(baseline.split(".")[0]!);
  if (name.length >= 5 && skeleton(host.split(".")[0]!).includes(name)) return `contains the name in ${baseline} with extra words added`;
  return null;
}

function linesMatching(text: string, re: RegExp): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && re.test(l));
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;

const IRREVERSIBLE_PAYMENT = /\bwire transfer\b|\bwire\b|\bzelle\b|\bvenmo\b|\bcash ?app\b|\bgift ?cards?\b|\bbitcoin\b|\bcrypto(currency)?\b|\bwestern union\b|\bmoneygram\b/i;
const PRESSURE =
  /\bwithin \d+ (hours|hrs)\b|\bin the next \d+ (hours|hrs)\b|\buntil \d{1,2}(:\d\d)?\s?(am|pm) today\b|\bby (tonight|end of (the )?day today)\b|\bimmediately\b|\bright away\b|\b(\d+|two|three|four|several|many|other) (other )?applicants\b|\bfirst come\b|\b(goes|go|will go) to the next applicant\b|\blose (the|this|your) (unit|apartment|spot|place)\b|\bbefore (the |a )?(viewing|showing|tour)\b|\bsight unseen\b|\bwithout (a )?(viewing|tour|showing)\b/i;

const SENSITIVE: { id: string; re: RegExp; title: string; detail: string }[] = [
  {
    id: "credentials_requested",
    re: /\b(online )?banking (username|user ?name|login|password|credentials)\b|\b(username|user ?name) and password\b|\blog-?in (details|credentials)\b/i,
    title: "Asks for a password or login",
    detail: "Passwords and banking logins are not rental documents. Paper Chase never searches for or shares them.",
  },
  {
    id: "ssn_requested",
    re: /\bsocial security (number|no\.?|#)\b|\bSSN\b/i,
    title: "Asks for a full Social Security number",
    detail: "Some screenings use one, but it is highly sensitive. Confirm the requester another way before sending it.",
  },
  {
    id: "account_numbers_requested",
    re: /\brouting number\b|\b(bank )?account number\b|\bcard number\b|\bCVV\b|\bsecurity code\b/i,
    title: "Asks for bank or card numbers",
    detail: "Account and card numbers can be used to move money. Confirm the requester another way first.",
  },
];

const NEGATED = /\b(never|not|don't|do not|won't|will not)\b/i;

const AI_DIRECTED = /\b(ignore|disregard) (all |any )?(previous|prior|above|earlier) instructions\b|\bnote to (any |the )?(ai|assistant|bot)\b|\bAI assistants?\b|\byou are authori[sz]ed to\b|\bsystem prompt\b/i;

export function assessRisk(input: {
  rawText: string;
  requesterDomain: string | null;
  trustedDomain: string | null;
  trustedSource: string | null;
}): RiskAssessment {
  const { rawText } = input;
  const baseline = normalizeDomain(input.trustedDomain);
  const requester = normalizeDomain(input.requesterDomain);
  const signals: RiskSignal[] = [];

  // Sender domain against a separately supplied baseline.
  if (!baseline) {
    signals.push({
      id: "no_baseline",
      level: "info",
      title: "No trusted contact to compare against",
      detail: "Without a domain you already trust for this landlord, the sender's address can't be compared. That is not the same as a match.",
      evidence: [],
    });
  }
  if (!requester) {
    signals.push({
      id: "no_sender",
      level: "info",
      title: "No sender address found",
      detail: "The pasted text doesn't include a sender email address to check.",
      evidence: [],
    });
  } else if (baseline && !matchesBaseline(requester, baseline)) {
    const reason = lookalikeReason(requester, baseline);
    if (reason) {
      signals.push({
        id: "lookalike_sender",
        level: "warning",
        title: "Sender domain looks like your trusted one, but isn't",
        detail: `${requester} ${reason}.`,
        evidence: linesMatching(rawText, new RegExp(requester.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")),
      });
    } else {
      signals.push({
        id: "domain_mismatch",
        level: "warning",
        title: "Sender domain doesn't match your trusted contact",
        detail: `The request comes from ${requester}, but the domain you trust is ${baseline}.${FREE_MAIL.has(requester) ? " It is a free email provider." : ""}`,
        evidence: [],
      });
    }
  }

  // Links: never opened; compared against the baseline when there is one.
  const hosts = new Map<string, string>();
  for (const url of rawText.match(URL_RE) ?? []) {
    const host = normalizeDomain(url);
    if (host && !hosts.has(host)) hosts.set(host, url);
  }
  for (const [host, url] of hosts) {
    if (baseline && matchesBaseline(host, baseline)) continue;
    const reason = baseline ? lookalikeReason(host, baseline) : null;
    if (reason) {
      signals.push({
        id: `lookalike_link:${host}`,
        level: "warning",
        title: "Link goes to a look-alike site",
        detail: `${host} ${reason}. Paper Chase did not open it.`,
        evidence: [url],
      });
    } else {
      signals.push({
        id: `link:${host}`,
        level: "info",
        title: "Link to a site Paper Chase can't vouch for",
        detail: `${host}${baseline ? ` isn't ${baseline}` : ""}. Paper Chase did not open it.${url.startsWith("http://") ? " It also isn't encrypted (http)." : ""}`,
        evidence: [url],
      });
    }
  }

  // Highly sensitive identifiers. Lines like "we will never ask for your password" don't count.
  for (const s of SENSITIVE) {
    let evidence = linesMatching(rawText, s.re).filter((l) => !NEGATED.test(l));
    if (s.id === "ssn_requested") evidence = evidence.filter((l) => !/\blast (4|four)\b/i.test(l));
    if (evidence.length) signals.push({ id: s.id, level: "warning", title: s.title, detail: s.detail, evidence });
  }

  // Payment pressure only as a combination: a hard-to-reverse method plus urgency or pressure.
  const paymentLines = linesMatching(rawText, IRREVERSIBLE_PAYMENT);
  const pressureLines = linesMatching(rawText, PRESSURE);
  if (paymentLines.length && pressureLines.length) {
    signals.push({
      id: "payment_pressure",
      level: "warning",
      title: "Hard-to-reverse payment combined with pressure",
      detail: "A request to pay by wire, gift card, crypto or a payment app, together with a short deadline or pressure to act, is a common pattern worth checking.",
      evidence: [...new Set([...paymentLines, ...pressureLines])],
    });
  } else if (paymentLines.length) {
    signals.push({
      id: "irreversible_payment",
      level: "info",
      title: "Mentions a hard-to-reverse payment method",
      detail: "On its own this isn't unusual, but these payments are hard to get back.",
      evidence: paymentLines,
    });
  }

  if (AI_DIRECTED.test(rawText)) {
    signals.push({
      id: "ai_directed_text",
      level: "warning",
      title: "Contains instructions aimed at AI tools",
      detail: "Paper Chase treats the pasted text as data and does not follow instructions inside it.",
      evidence: linesMatching(rawText, AI_DIRECTED),
    });
  }

  const hasWarnings = signals.some((s) => s.level === "warning");
  return {
    signals,
    hasWarnings,
    summary: hasWarnings ? HOLD_SUMMARY : CLEAN_SUMMARY,
    baseline: { domain: baseline, source: baseline ? input.trustedSource : null },
    requesterDomain: requester,
  };
}
