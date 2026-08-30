import { describe, expect, it } from "vitest";
import { createIcs, parseIcsEvents, updateIcs } from "../src/ical";

describe("iCalendar helpers", () => {
  it("creates and parses a recurring event with an alarm", () => {
    const ics = createIcs({
      uid: "test@example",
      title: "课题组会议",
      start: "2026-09-02T14:00:00+08:00",
      end: "2026-09-02T16:00:00+08:00",
      allDay: false,
      timezone: "Asia/Shanghai",
      reminderMinutes: 30,
      recurrence: { frequency: "WEEKLY", count: 12, byWeekday: ["WE"] },
    });
    const event = parseIcsEvents(ics, "Asia/Shanghai")[0];
    expect(event.uid).toBe("test@example");
    expect(event.recurrence).toContain("FREQ=WEEKLY");
    expect(event.reminder_minutes).toEqual([30]);
  });

  it("updates the whole series and increments sequence", () => {
    const original = createIcs({
      uid: "update@example",
      title: "Old",
      start: "2026-09-03T14:00:00+08:00",
      end: "2026-09-03T16:00:00+08:00",
      allDay: false,
      timezone: "Asia/Shanghai",
    });
    const updated = updateIcs(original, {
      title: "New",
      start: "2026-09-03T15:00:00+08:00",
      timezone: "Asia/Shanghai",
    });
    const event = parseIcsEvents(updated, "Asia/Shanghai")[0];
    expect(event.title).toBe("New");
    expect(event.start).toBe("2026-09-03T07:00:00Z");
    expect(event.end).toBe("2026-09-03T09:00:00Z");
    expect(updated).toContain("SEQUENCE:1");
  });
});
