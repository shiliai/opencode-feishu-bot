const MONTH_ALIASES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function resolveValue(
  s: string,
  aliases?: Record<string, number>,
): number | null {
  if (/^\d+$/.test(s)) {
    return Number.parseInt(s, 10);
  }
  if (aliases && s in aliases) {
    return aliases[s];
  }
  return null;
}

function parseField(
  field: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed === "*") {
      for (let i = min; i <= max; i++) {
        values.add(i);
      }
      continue;
    }

    let step = 1;
    let rangePart = trimmed;
    const stepIdx = trimmed.indexOf("/");
    if (stepIdx > 0) {
      step = Number.parseInt(trimmed.slice(stepIdx + 1), 10);
      if (!Number.isFinite(step) || step <= 0) {
        continue;
      }
      rangePart = trimmed.slice(0, stepIdx);
    }

    let start: number | null;
    let end: number | null;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else {
      const dashIdx = rangePart.indexOf("-");
      if (dashIdx > 0) {
        start = resolveValue(rangePart.slice(0, dashIdx), aliases);
        end = resolveValue(rangePart.slice(dashIdx + 1), aliases);
      } else {
        start = end = resolveValue(rangePart, aliases);
      }
    }

    if (start == null || end == null) {
      continue;
    }
    for (let i = start; i <= end; i += step) {
      if (i >= min && i <= max) {
        values.add(i);
      }
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

export function computeNextCronRunAt(
  cronExpression: string,
  _timezone: string,
  after?: Date,
): Date | null {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return null;
  }

  const [minuteField, hourField, domField, monthField, dowField] = fields;
  const minutes = parseField(minuteField, 0, 59);
  const hours = parseField(hourField, 0, 23);
  const doms = parseField(domField, 1, 31);
  const months = parseField(monthField, 1, 12, MONTH_ALIASES);
  const dows = parseField(dowField, 0, 6, WEEKDAY_ALIASES);

  if (!minutes.length || !hours.length || !months.length) {
    return null;
  }

  const start = after ?? new Date();
  const candidate = new Date(start.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxTime = start.getTime() + 2 * 365 * 24 * 60 * 60 * 1000;

  while (candidate.getTime() < maxTime) {
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const d = candidate.getDate();
    const mo = candidate.getMonth() + 1;
    const dow = candidate.getDay();

    if (!months.includes(mo)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    if (!hours.includes(h) || !minutes.includes(m)) {
      candidate.setMinutes(candidate.getMinutes() + 1);
      continue;
    }

    const domMatch = doms.includes(d);
    const dowMatch = dows.includes(dow);
    const domWildcard = domField.trim() === "*";
    const dowWildcard = dowField.trim() === "*";
    const dayMatch = (domWildcard && dowWildcard) || domMatch || dowMatch;

    if (!dayMatch) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    return candidate;
  }

  return null;
}

export function validateCronMinGap(
  cronExpression: string,
  minGapMinutes = 5,
): boolean {
  const first = computeNextCronRunAt(cronExpression, "UTC");
  if (!first) {
    return false;
  }
  const second = computeNextCronRunAt(cronExpression, "UTC", first);
  if (!second) {
    return true;
  }
  const gapMs = second.getTime() - first.getTime();
  return gapMs >= minGapMinutes * 60 * 1000;
}
