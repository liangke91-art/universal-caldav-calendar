import { Temporal } from "@js-temporal/polyfill";
import { CalDavClient, toCalDavTimestamp, type CalDavCalendar, type CalDavResource } from "./caldav";
import { loadCredentials, type CalendarCredentials } from "./credentials";
import {
  createIcs,
  normalizeIsoDateTime,
  parseIcsEvents,
  updateIcs,
  type CalendarEvent,
  type RecurrenceInput,
} from "./ical";

export type RemoteEvent = CalendarEvent & {
  calendar: string;
  resource_url: string;
};

export class CalendarService {
  private constructor(
    private readonly credentials: CalendarCredentials,
    private readonly client: CalDavClient,
  ) {}

  static async forUser(env: Env, userId: string): Promise<CalendarService> {
    const credentials = await loadCredentials(env, userId);
    if (!credentials) throw new Error("No CalDAV account is connected. Create a secure setup link first.");
    return new CalendarService(credentials, new CalDavClient(credentials));
  }

  get timezone(): string {
    return this.credentials.timezone || "Asia/Shanghai";
  }

  private normalize(value: string): string {
    return normalizeIsoDateTime(value, this.timezone);
  }

  async connectionStatus(): Promise<Record<string, unknown>> {
    const calendars = await this.client.discoverCalendars();
    return {
      connected: true,
      server: this.credentials.serverUrl,
      username_set: true,
      password_set: true,
      timezone: this.timezone,
      default_calendar: this.credentials.defaultCalendar ?? null,
      calendars: calendars.map((calendar) => calendar.name),
    };
  }

  async listCalendars(): Promise<CalDavCalendar[]> {
    return this.client.discoverCalendars();
  }

  private async selectedCalendars(names?: string[]): Promise<CalDavCalendar[]> {
    if (!names?.length) return this.client.discoverCalendars();
    const all = await this.client.discoverCalendars();
    return names.map((name) => {
      const normalized = name.trim().toLocaleLowerCase();
      const calendar = all.find((item) => item.name.toLocaleLowerCase() === normalized);
      if (!calendar) throw new Error(`Calendar '${name}' was not found.`);
      return calendar;
    });
  }

  private parseResources(resources: CalDavResource[], calendar: CalDavCalendar): RemoteEvent[] {
    return resources.flatMap((resource) =>
      parseIcsEvents(resource.ics, this.timezone).map((event) => ({
        ...event,
        calendar: calendar.name,
        resource_url: resource.href,
      })),
    );
  }

  async listEvents(
    start: string,
    end: string,
    calendarNames?: string[],
    maxResults = 200,
  ): Promise<RemoteEvent[]> {
    const startIso = this.normalize(start);
    const endIso = this.normalize(end);
    if (Temporal.Instant.compare(startIso, endIso) >= 0) throw new Error("End must be later than start.");
    const calendars = calendarNames?.length
      ? await this.selectedCalendars(calendarNames)
      : this.credentials.defaultCalendar
        ? [await this.client.selectCalendar(this.credentials.defaultCalendar)]
        : await this.client.discoverCalendars();
    const events: RemoteEvent[] = [];
    for (const calendar of calendars) {
      const resources = await this.client.queryEvents(
        calendar.url,
        toCalDavTimestamp(startIso),
        toCalDavTimestamp(endIso),
        true,
      );
      events.push(...this.parseResources(resources, calendar));
    }
    const rangeStart = Temporal.Instant.from(startIso).epochMilliseconds;
    const rangeEnd = Temporal.Instant.from(endIso).epochMilliseconds;
    const filtered = events
      .filter((event) => {
        if (event.status.toUpperCase() === "CANCELLED") return false;
        const [eventStart, eventEnd] = this.eventInterval(event);
        return eventStart < rangeEnd && eventEnd > rangeStart;
      })
      .sort((left, right) => left.start.localeCompare(right.start))
      .slice(0, Math.max(1, Math.min(maxResults, 1000)));
    return filtered;
  }

  async createEvent(input: {
    title: string;
    start: string;
    end: string;
    calendarName?: string;
    description?: string;
    location?: string;
    allDay?: boolean;
    reminderMinutes?: number;
    recurrence?: RecurrenceInput;
  }): Promise<RemoteEvent> {
    if (!input.title.trim()) throw new Error("Event title cannot be empty.");
    const calendar = await this.client.selectCalendar(input.calendarName);
    const uid = `${crypto.randomUUID()}@universal-caldav-calendar`;
    const ics = createIcs({
      uid,
      title: input.title.trim(),
      start: input.start,
      end: input.end,
      allDay: input.allDay ?? false,
      timezone: this.timezone,
      description: input.description,
      location: input.location,
      reminderMinutes: input.reminderMinutes ?? this.credentials.defaultReminderMinutes,
      recurrence: input.recurrence,
    });
    const resource = await this.client.createEvent(calendar.url, uid, ics);
    return this.parseResources([resource], calendar)[0];
  }

  async updateEvent(
    uid: string,
    input: {
      calendarName?: string;
      title?: string;
      start?: string;
      end?: string;
      description?: string;
      location?: string;
      reminderMinutes?: number;
      clearReminder?: boolean;
      recurrence?: RecurrenceInput;
      clearRecurrence?: boolean;
    },
  ): Promise<RemoteEvent> {
    const calendars = input.calendarName ? [await this.client.selectCalendar(input.calendarName)] : undefined;
    const found = await this.client.findEventByUid(uid, calendars);
    const ics = updateIcs(found.resource.ics, { ...input, timezone: this.timezone });
    const resource = await this.client.updateEvent(found.resource, ics);
    return this.parseResources([resource], found.calendar).find((event) => !event.recurrence_id) ?? this.parseResources([resource], found.calendar)[0];
  }

  async deleteEvent(uid: string, calendarName?: string): Promise<RemoteEvent> {
    const calendars = calendarName ? [await this.client.selectCalendar(calendarName)] : undefined;
    const found = await this.client.findEventByUid(uid, calendars);
    const event = this.parseResources([found.resource], found.calendar).find((item) => !item.recurrence_id) ?? this.parseResources([found.resource], found.calendar)[0];
    await this.client.deleteEvent(found.resource);
    return event;
  }

  async searchEvents(query: string, start: string, end: string, calendarNames?: string[]): Promise<RemoteEvent[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) throw new Error("Search query cannot be empty.");
    return (await this.listEvents(start, end, calendarNames, 1000)).filter((event) =>
      [event.title, event.description, event.location].some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }

  private eventInterval(event: RemoteEvent): [number, number] {
    if (!event.all_day) {
      return [Temporal.Instant.from(event.start).epochMilliseconds, Temporal.Instant.from(event.end).epochMilliseconds];
    }
    const start = Temporal.PlainDate.from(event.start)
      .toZonedDateTime({ timeZone: this.timezone, plainTime: Temporal.PlainTime.from("00:00") })
      .toInstant().epochMilliseconds;
    const end = Temporal.PlainDate.from(event.end)
      .toZonedDateTime({ timeZone: this.timezone, plainTime: Temporal.PlainTime.from("00:00") })
      .toInstant().epochMilliseconds;
    return [start, end];
  }

  async checkConflicts(start: string, end: string, calendarNames?: string[]): Promise<RemoteEvent[]> {
    const startIso = this.normalize(start);
    const endIso = this.normalize(end);
    const from = Temporal.Instant.from(startIso).epochMilliseconds;
    const to = Temporal.Instant.from(endIso).epochMilliseconds;
    const names = calendarNames ?? (await this.listCalendars()).map((calendar) => calendar.name);
    return (await this.listEvents(startIso, endIso, names, 1000)).filter((event) => {
      if (event.transparency.toUpperCase() === "TRANSPARENT") return false;
      const [busyStart, busyEnd] = this.eventInterval(event);
      return busyStart < to && busyEnd > from;
    });
  }

  async findFreeTime(input: {
    start: string;
    end: string;
    durationMinutes: number;
    calendarNames?: string[];
    workdayStart?: string;
    workdayEnd?: string;
    weekdaysOnly?: boolean;
    slotMinutes?: number;
    maxResults?: number;
  }): Promise<Array<{ start: string; end: string }>> {
    const startIso = this.normalize(input.start);
    const endIso = this.normalize(input.end);
    const rangeStart = Temporal.Instant.from(startIso).epochMilliseconds;
    const rangeEnd = Temporal.Instant.from(endIso).epochMilliseconds;
    const durationMs = input.durationMinutes * 60_000;
    const stepMs = (input.slotMinutes ?? 15) * 60_000;
    if (durationMs <= 0 || stepMs <= 0) throw new Error("Durations must be positive.");
    const names = input.calendarNames ?? (await this.listCalendars()).map((calendar) => calendar.name);
    const busy = (await this.listEvents(startIso, endIso, names, 1000))
      .filter((event) => event.transparency.toUpperCase() !== "TRANSPARENT")
      .map((event) => this.eventInterval(event))
      .sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const interval of busy) {
      const previous = merged.at(-1);
      if (!previous || interval[0] > previous[1]) merged.push([...interval]);
      else previous[1] = Math.max(previous[1], interval[1]);
    }
    const results: Array<{ start: string; end: string }> = [];
    const maxResults = Math.min(input.maxResults ?? 20, 200);
    let day = Temporal.Instant.from(startIso).toZonedDateTimeISO(this.timezone).toPlainDate();
    const lastDay = Temporal.Instant.from(endIso).toZonedDateTimeISO(this.timezone).toPlainDate();
    while (Temporal.PlainDate.compare(day, lastDay) <= 0 && results.length < maxResults) {
      const weekday = day.dayOfWeek;
      if (!(input.weekdaysOnly ?? true) || weekday <= 5) {
        const windowStart = Math.max(
          rangeStart,
          day.toZonedDateTime({ timeZone: this.timezone, plainTime: Temporal.PlainTime.from(input.workdayStart ?? "08:00") }).toInstant().epochMilliseconds,
        );
        const windowEnd = Math.min(
          rangeEnd,
          day.toZonedDateTime({ timeZone: this.timezone, plainTime: Temporal.PlainTime.from(input.workdayEnd ?? "18:00") }).toInstant().epochMilliseconds,
        );
        let candidate = Math.ceil(windowStart / stepMs) * stepMs;
        while (candidate + durationMs <= windowEnd && results.length < maxResults) {
          const overlaps = merged.some(([busyStart, busyEnd]) => busyStart < candidate + durationMs && busyEnd > candidate);
          if (!overlaps) {
            results.push({
              start: Temporal.Instant.fromEpochMilliseconds(candidate).toString(),
              end: Temporal.Instant.fromEpochMilliseconds(candidate + durationMs).toString(),
            });
          }
          candidate += stepMs;
        }
      }
      day = day.add({ days: 1 });
    }
    return results;
  }
}
