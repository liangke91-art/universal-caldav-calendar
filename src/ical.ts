import { Temporal } from "@js-temporal/polyfill";

type IcalProperty = { value: string; params: Record<string, string> };

export type CalendarEvent = {
  uid: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  description: string;
  location: string;
  status: string;
  transparency: string;
  recurrence?: string;
  recurrence_id?: string;
  reminder_minutes: number[];
};

export type RecurrenceInput = {
  frequency?: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval?: number;
  count?: number;
  until?: string;
  byWeekday?: Array<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU">;
};

export type CreateEventInput = {
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  description?: string;
  location?: string;
  reminderMinutes?: number;
  recurrence?: RecurrenceInput;
};

export type UpdateEventInput = {
  title?: string;
  start?: string;
  end?: string;
  timezone: string;
  description?: string;
  location?: string;
  reminderMinutes?: number;
  clearReminder?: boolean;
  recurrence?: RecurrenceInput;
  clearRecurrence?: boolean;
};

export function unfoldIcs(ics: string): string[] {
  // Some CalDAV XML responses preserve CR in CRLF as a numeric XML entity,
  // yielding literal `&#13;\n` (or `&#xD;\n`) after XML parsing. Restore the
  // transport line ending before applying RFC 5545 line unfolding.
  const transportNormalized = ics
    .replace(/&#(?:13|x0*d);(?=\r?\n|$)/gi, "\r");
  const physical = transportNormalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const logical: string[] = [];
  for (const line of physical) {
    const trimmed = line.trimStart();
    const serverIndentedProperty =
      (line.startsWith(" ") || line.startsWith("\t")) && /^[A-Z0-9-]+(?:;[^:]*)?:/i.test(trimmed);
    if (serverIndentedProperty) {
      // Some CalDAV XML serializers indent every line inside calendar-data.
      // Those are complete iCalendar properties, not RFC 5545 folded lines.
      logical.push(trimmed);
    } else if ((line.startsWith(" ") || line.startsWith("\t")) && logical.length) {
      logical[logical.length - 1] += line.slice(1);
    } else if (line.length) {
      logical.push(line);
    }
  }
  return logical;
}

function parseProperty(line: string): [string, IcalProperty] {
  const colon = line.indexOf(":");
  const header = colon >= 0 ? line.slice(0, colon) : line;
  const value = colon >= 0 ? line.slice(colon + 1) : "";
  const [rawName, ...rawParams] = header.split(";");
  const params: Record<string, string> = {};
  for (const raw of rawParams) {
    const equals = raw.indexOf("=");
    if (equals > 0) params[raw.slice(0, equals).toUpperCase()] = raw.slice(equals + 1).replace(/^"|"$/g, "");
  }
  return [rawName.toUpperCase(), { value, params }];
}

function eventBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  let depth = 0;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      current = [line];
      depth = 1;
      continue;
    }
    if (!current) continue;
    current.push(line);
    if (upper.startsWith("BEGIN:")) depth += 1;
    if (upper.startsWith("END:")) depth -= 1;
    if (depth === 0) {
      blocks.push(current);
      current = null;
    }
  }
  return blocks;
}

function topLevelProperties(block: string[]): Map<string, IcalProperty[]> {
  const properties = new Map<string, IcalProperty[]>();
  let nested = 0;
  for (const line of block.slice(1, -1)) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      nested += 1;
      continue;
    }
    if (upper.startsWith("END:")) {
      nested -= 1;
      continue;
    }
    if (nested !== 0) continue;
    const [name, property] = parseProperty(line);
    const values = properties.get(name) ?? [];
    values.push(property);
    properties.set(name, values);
  }
  return properties;
}

function unescapeText(value: string): string {
  return value.replace(/\\[nN]/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function icalDateToIso(property: IcalProperty, defaultTimezone: string): { value: string; allDay: boolean } {
  const raw = property.value.trim();
  if (property.params.VALUE === "DATE" || /^\d{8}$/.test(raw)) {
    return { value: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, allDay: true };
  }
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) throw new Error(`Unsupported iCalendar date-time: ${raw}`);
  const plain = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  const instant = match[7]
    ? Temporal.Instant.from(`${plain}Z`)
    : Temporal.PlainDateTime.from(plain).toZonedDateTime(property.params.TZID || defaultTimezone).toInstant();
  return { value: instant.toString(), allDay: false };
}

function addToIso(value: string, duration: Temporal.DurationLike, allDay: boolean): string {
  if (allDay) return Temporal.PlainDate.from(value).add(duration).toString();
  return Temporal.Instant.from(value).add(duration).toString();
}

function parseAlarmMinutes(block: string[]): number[] {
  const values: number[] = [];
  let inAlarm = false;
  for (const line of block) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VALARM") inAlarm = true;
    else if (upper === "END:VALARM") inAlarm = false;
    else if (inAlarm && upper.startsWith("TRIGGER")) {
      const [, property] = parseProperty(line);
      const match = property.value.match(/^-P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i);
      if (match) values.push(Number(match[1] || 0) * 1440 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
    }
  }
  return values;
}

export function parseIcsEvents(ics: string, defaultTimezone: string): CalendarEvent[] {
  const unfolded = unfoldIcs(ics);
  const blocks = eventBlocks(unfolded);
  return blocks.map((block) => {
    const props = topLevelProperties(block);
    const first = (name: string) => props.get(name)?.[0];
    const startProperty = first("DTSTART");
    if (!startProperty) throw new Error("Calendar event is missing DTSTART.");
    const start = icalDateToIso(startProperty, defaultTimezone);
    const endProperty = first("DTEND");
    const end = endProperty ? icalDateToIso(endProperty, defaultTimezone).value : addToIso(start.value, { days: start.allDay ? 1 : 0 }, start.allDay);
    const recurrenceId = first("RECURRENCE-ID");
    return {
      uid: first("UID")?.value ?? "",
      title: unescapeText(first("SUMMARY")?.value ?? ""),
      start: start.value,
      end,
      all_day: start.allDay,
      description: unescapeText(first("DESCRIPTION")?.value ?? ""),
      location: unescapeText(first("LOCATION")?.value ?? ""),
      status: first("STATUS")?.value ?? "CONFIRMED",
      transparency: first("TRANSP")?.value ?? "OPAQUE",
      recurrence: first("RRULE")?.value,
      recurrence_id: recurrenceId ? icalDateToIso(recurrenceId, defaultTimezone).value : undefined,
      reminder_minutes: parseAlarmMinutes(block),
    };
  });
}

function normalizeDateTime(value: string, timezone: string, allDay: boolean): string {
  if (allDay) return Temporal.PlainDate.from(value.slice(0, 10)).toString();
  const trimmed = value.trim();
  try {
    return Temporal.Instant.from(trimmed).toString();
  } catch {
    return Temporal.PlainDateTime.from(trimmed).toZonedDateTime(timezone).toInstant().toString();
  }
}

export function normalizeIsoDateTime(value: string, timezone: string): string {
  return normalizeDateTime(value, timezone, false);
}

function formatIcalDate(name: string, iso: string, allDay: boolean): string {
  if (allDay) return `${name};VALUE=DATE:${iso.replace(/-/g, "")}`;
  const instant = Temporal.Instant.from(iso).toString({ smallestUnit: "second" });
  return `${name}:${instant.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

function rruleLine(recurrence: RecurrenceInput | undefined, timezone: string, allDay: boolean): string | undefined {
  if (!recurrence?.frequency) return undefined;
  const interval = recurrence.interval ?? 1;
  if (interval < 1) throw new Error("recurrence interval must be at least 1.");
  if (recurrence.count && recurrence.until) throw new Error("Use recurrence count or until, not both.");
  const parts = [`FREQ=${recurrence.frequency}`, `INTERVAL=${interval}`];
  if (recurrence.count) parts.push(`COUNT=${recurrence.count}`);
  if (recurrence.until) {
    const normalized = normalizeDateTime(recurrence.until, timezone, allDay);
    parts.push(`UNTIL=${allDay ? normalized.replace(/-/g, "") : formatIcalDate("UNTIL", normalized, false).slice(6)}`);
  }
  if (recurrence.byWeekday?.length) parts.push(`BYDAY=${recurrence.byWeekday.join(",")}`);
  return `RRULE:${parts.join(";")}`;
}

function alarmLines(minutes: number | undefined): string[] {
  if (minutes === undefined || minutes === 0) return [];
  if (!Number.isInteger(minutes) || minutes < 0) throw new Error("Reminder minutes must be a non-negative integer.");
  return ["BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-PT${minutes}M`, "DESCRIPTION:Calendar reminder", "END:VALARM"];
}

function foldLine(line: string): string {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of line) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > 73 && current) {
      chunks.push(current);
      current = " " + character;
      bytes = 1 + size;
    } else {
      current += character;
      bytes += size;
    }
  }
  chunks.push(current);
  return chunks.join("\r\n");
}

function serialize(lines: string[]): string {
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

export function createIcs(input: CreateEventInput): string {
  const start = normalizeDateTime(input.start, input.timezone, input.allDay);
  const end = normalizeDateTime(input.end, input.timezone, input.allDay);
  if (input.allDay ? Temporal.PlainDate.compare(end, start) <= 0 : Temporal.Instant.compare(end, start) <= 0) {
    throw new Error("Event end must be later than start.");
  }
  const now = Temporal.Now.instant().toString({ smallestUnit: "second" }).replace(/[-:]/g, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Universal CalDAV Calendar//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `DTSTAMP:${now}`,
    `CREATED:${now}`,
    `LAST-MODIFIED:${now}`,
    formatIcalDate("DTSTART", start, input.allDay),
    formatIcalDate("DTEND", end, input.allDay),
    `SUMMARY:${escapeText(input.title)}`,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "SEQUENCE:0",
  ];
  if (input.description) lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  if (input.location) lines.push(`LOCATION:${escapeText(input.location)}`);
  const recurrence = rruleLine(input.recurrence, input.timezone, input.allDay);
  if (recurrence) lines.push(recurrence);
  lines.push(...alarmLines(input.reminderMinutes), "END:VEVENT", "END:VCALENDAR");
  return serialize(lines);
}

function durationBetween(start: string, end: string, allDay: boolean): Temporal.Duration {
  if (allDay) return Temporal.PlainDate.from(start).until(Temporal.PlainDate.from(end));
  return Temporal.Instant.from(start).until(Temporal.Instant.from(end));
}

export function updateIcs(ics: string, input: UpdateEventInput): string {
  const parsed = parseIcsEvents(ics, input.timezone);
  const master = parsed.find((event) => !event.recurrence_id) ?? parsed[0];
  if (!master) throw new Error("Calendar resource contains no event.");
  const requestedAllDay = input.start ? /^\d{4}-\d{2}-\d{2}$/.test(input.start.trim()) : master.all_day;
  let start = input.start ? normalizeDateTime(input.start, input.timezone, requestedAllDay) : master.start;
  let end: string;
  if (input.end) {
    const endAllDay = /^\d{4}-\d{2}-\d{2}$/.test(input.end.trim());
    if (endAllDay !== requestedAllDay) throw new Error("Start and end must both be date-only or both be date-times.");
    end = normalizeDateTime(input.end, input.timezone, requestedAllDay);
  } else if (input.start) {
    end = requestedAllDay === master.all_day
      ? (requestedAllDay
          ? Temporal.PlainDate.from(start).add(durationBetween(master.start, master.end, true)).toString()
          : Temporal.Instant.from(start).add(durationBetween(master.start, master.end, false)).toString())
      : requestedAllDay
        ? Temporal.PlainDate.from(start).add({ days: 1 }).toString()
        : Temporal.Instant.from(start).add({ hours: 1 }).toString();
  } else {
    end = master.end;
  }
  const replacement = new Map<string, string | null>();
  if (input.title !== undefined) replacement.set("SUMMARY", `SUMMARY:${escapeText(input.title)}`);
  if (input.start !== undefined) replacement.set("DTSTART", formatIcalDate("DTSTART", start, requestedAllDay));
  if (input.start !== undefined || input.end !== undefined) replacement.set("DTEND", formatIcalDate("DTEND", end, requestedAllDay));
  if (input.description !== undefined) replacement.set("DESCRIPTION", input.description ? `DESCRIPTION:${escapeText(input.description)}` : null);
  if (input.location !== undefined) replacement.set("LOCATION", input.location ? `LOCATION:${escapeText(input.location)}` : null);
  if (input.clearRecurrence) replacement.set("RRULE", null);
  else if (input.recurrence?.frequency) replacement.set("RRULE", rruleLine(input.recurrence, input.timezone, requestedAllDay) ?? null);
  replacement.set("DTSTAMP", `DTSTAMP:${Temporal.Now.instant().toString({ smallestUnit: "second" }).replace(/[-:]/g, "")}`);
  replacement.set("LAST-MODIFIED", `LAST-MODIFIED:${Temporal.Now.instant().toString({ smallestUnit: "second" }).replace(/[-:]/g, "")}`);

  const lines = unfoldIcs(ics);
  const blocks = eventBlocks(lines);
  const masterBlock = blocks.find((block) => !topLevelProperties(block).has("RECURRENCE-ID")) ?? blocks[0];
  if (!masterBlock) throw new Error("Calendar resource contains no VEVENT.");
  const originalSequence = Number.parseInt(topLevelProperties(masterBlock).get("SEQUENCE")?.[0]?.value ?? "0", 10);
  replacement.set("SEQUENCE", `SEQUENCE:${Number.isFinite(originalSequence) ? originalSequence + 1 : 1}`);
  const blockStart = lines.findIndex((_, index) => lines.slice(index, index + masterBlock.length).join("\n") === masterBlock.join("\n"));
  if (blockStart < 0) throw new Error("Could not locate the event to update.");

  const replaceAlarm = input.clearReminder || input.reminderMinutes !== undefined;
  const rebuilt: string[] = [masterBlock[0]];
  let nested = 0;
  let skippingAlarm = false;
  for (const line of masterBlock.slice(1, -1)) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VALARM" && replaceAlarm) {
      skippingAlarm = true;
      continue;
    }
    if (skippingAlarm) {
      if (upper === "END:VALARM") skippingAlarm = false;
      continue;
    }
    if (upper.startsWith("BEGIN:")) nested += 1;
    if (upper.startsWith("END:")) nested -= 1;
    if (nested === 0) {
      const [name] = parseProperty(line);
      if (replacement.has(name)) continue;
    }
    rebuilt.push(line);
  }
  for (const value of replacement.values()) if (value) rebuilt.push(value);
  if (replaceAlarm && !input.clearReminder) rebuilt.push(...alarmLines(input.reminderMinutes));
  rebuilt.push("END:VEVENT");
  const next = [...lines.slice(0, blockStart), ...rebuilt, ...lines.slice(blockStart + masterBlock.length)];
  return serialize(next);
}
