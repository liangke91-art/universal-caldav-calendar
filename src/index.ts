import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { handleAuthRequest, type AuthProps } from "./auth";
import { CalendarService } from "./calendar-service";
import {
  createSetupLink,
  deleteCredentials,
  handleSetupRequest,
  loadCredentials,
} from "./credentials";

const recurrenceSchema = z
  .object({
    frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
    interval: z.number().int().min(1).default(1),
    count: z.number().int().min(1).optional(),
    until: z.string().optional(),
    byWeekday: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])).optional(),
  })
  .optional();

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function createCalendarServer(env: Env) {
  const server = new McpServer(
    { name: "Universal CalDAV Calendar", version: "0.1.0" },
    {
      instructions:
        "Use these tools for the authenticated user's CalDAV calendars. Create or update only when the user asks for a calendar change. Before deleting an event, confirm its UID and require an explicit deletion request; pass confirm=true only then. Updating or deleting a recurring event affects the entire series. Never request CalDAV credentials in chat: call calendar_create_setup_link and let the user enter them on the secure HTTPS form. Naive date-times use the connected account timezone, Asia/Shanghai by default.",
    },
  );

  function identity(): AuthProps {
    const props = getMcpAuthContext()?.props as Partial<AuthProps> | undefined;
    if (!props?.userId || !props.login || !props.name) throw new Error("Authenticated user context is missing.");
    return props as AuthProps;
  }

  async function calendar(): Promise<CalendarService> {
    return CalendarService.forUser(env, identity().userId);
  }

  server.registerTool(
      "calendar_account_status",
      {
        title: "Calendar account status",
        description: "Check whether a CalDAV account is connected and, if so, test calendar discovery. Never returns credential values.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      },
      async () => {
        const configured = Boolean(await loadCredentials(env, identity().userId));
        if (!configured) return result({ connected: false, setup_required: true });
        return result(await (await calendar()).connectionStatus());
      },
    );

  server.registerTool(
      "calendar_create_setup_link",
      {
        title: "Create secure calendar setup link",
        description: "Create a one-time 10-minute HTTPS link where the user can enter CalDAV credentials without exposing them to the model or conversation.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async () => {
        const user = identity();
        return result({ setup_url: await createSetupLink(env, user.userId, `GitHub @${user.login}`), expires_in_seconds: 600 });
      },
    );

  server.registerTool(
      "calendar_disconnect_account",
      {
        title: "Disconnect CalDAV account",
        description: "Permanently remove the authenticated user's encrypted CalDAV credentials from this service. Does not delete calendar data.",
        inputSchema: z.object({ confirm: z.boolean().describe("Must be true after the user explicitly requests disconnection.") }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ confirm }) => {
        if (!confirm) throw new Error("Disconnection was not confirmed.");
        await deleteCredentials(env, identity().userId);
        return result({ disconnected: true });
      },
    );

  server.registerTool(
      "calendar_list_calendars",
      {
        title: "List calendars",
        description: "List every calendar in the connected CalDAV account.",
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      },
      async () => result({ calendars: await (await calendar()).listCalendars() }),
    );

  server.registerTool(
      "calendar_get_events",
      {
        title: "Get calendar events",
        description: "List events in a time range. Recurring series are requested as expanded occurrences from the CalDAV server.",
        inputSchema: z.object({
          start: z.string().describe("Inclusive ISO 8601 range start. Offset may be omitted to use account timezone."),
          end: z.string().describe("Exclusive ISO 8601 range end."),
          calendarNames: z.array(z.string()).optional().describe("Omit to use the default calendar, or all calendars when no default is set."),
          maxResults: z.number().int().min(1).max(1000).default(200),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ start, end, calendarNames, maxResults }) => {
        const events = await (await calendar()).listEvents(start, end, calendarNames, maxResults);
        return result({ count: events.length, events });
      },
    );

  server.registerTool(
      "calendar_search_events",
      {
        title: "Search calendar events",
        description: "Search event titles, descriptions, and locations inside a bounded time range.",
        inputSchema: z.object({
          query: z.string().min(1),
          start: z.string(),
          end: z.string(),
          calendarNames: z.array(z.string()).optional(),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ query, start, end, calendarNames }) => {
        const events = await (await calendar()).searchEvents(query, start, end, calendarNames);
        return result({ count: events.length, events });
      },
    );

  server.registerTool(
      "calendar_create_event",
      {
        title: "Create calendar event",
        description: "Create a one-off, all-day, or recurring event in a selected CalDAV calendar.",
        inputSchema: z.object({
          title: z.string().min(1),
          start: z.string().describe("ISO 8601 start; use YYYY-MM-DD for all-day events."),
          end: z.string().describe("ISO 8601 end; all-day end dates are exclusive."),
          calendarName: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
          allDay: z.boolean().default(false),
          reminderMinutes: z.number().int().min(0).optional().describe("Omit for configured default; use 0 to disable."),
          recurrence: recurrenceSchema,
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (input) => result({ created: true, event: await (await calendar()).createEvent(input) }),
    );

  server.registerTool(
      "calendar_update_event",
      {
        title: "Update calendar event",
        description: "Update an event by UID. If the event is recurring, this updates the entire series.",
        inputSchema: z.object({
          uid: z.string().min(1),
          calendarName: z.string().optional(),
          title: z.string().min(1).optional(),
          start: z.string().optional().describe("Moving start alone preserves the existing duration."),
          end: z.string().optional(),
          description: z.string().optional().describe("Use an empty string to clear."),
          location: z.string().optional().describe("Use an empty string to clear."),
          reminderMinutes: z.number().int().min(0).optional(),
          clearReminder: z.boolean().default(false),
          recurrence: recurrenceSchema,
          clearRecurrence: z.boolean().default(false),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ uid, ...input }) => result({ updated: true, scope: "entire_series_or_event", event: await (await calendar()).updateEvent(uid, input) }),
    );

  server.registerTool(
      "calendar_delete_event",
      {
        title: "Delete calendar event",
        description: "Delete an event by UID. If recurring, deletes the entire series. Requires explicit user confirmation.",
        inputSchema: z.object({ uid: z.string().min(1), calendarName: z.string().optional(), confirm: z.boolean() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ uid, calendarName, confirm }) => {
        if (!confirm) throw new Error("Deletion was not confirmed. Set confirm=true only after an explicit user request.");
        return result({ deleted: true, scope: "entire_series_or_event", event: await (await calendar()).deleteEvent(uid, calendarName) });
      },
    );

  server.registerTool(
      "calendar_find_free_time",
      {
        title: "Find free time",
        description: "Find candidate free slots after checking busy events across selected calendars.",
        inputSchema: z.object({
          start: z.string(),
          end: z.string(),
          durationMinutes: z.number().int().min(1),
          calendarNames: z.array(z.string()).optional().describe("Omit to check all calendars."),
          workdayStart: z.string().default("08:00"),
          workdayEnd: z.string().default("18:00"),
          weekdaysOnly: z.boolean().default(true),
          slotMinutes: z.number().int().min(1).default(15),
          maxResults: z.number().int().min(1).max(200).default(20),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      },
      async (input) => {
        const service = await calendar();
        const slots = await service.findFreeTime(input);
        return result({ count: slots.length, timezone: service.timezone, slots });
      },
    );

  server.registerTool(
      "calendar_check_conflicts",
      {
        title: "Check calendar conflicts",
        description: "Check whether a proposed time overlaps opaque busy events.",
        inputSchema: z.object({ start: z.string(), end: z.string(), calendarNames: z.array(z.string()).optional() }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ start, end, calendarNames }) => {
        const conflicts = await (await calendar()).checkConflicts(start, end, calendarNames);
        return result({ has_conflict: conflicts.length > 0, count: conflicts.length, conflicts });
      },
    );

  return server;
}

const mcpApiHandler: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    return createMcpHandler(() => createCalendarServer(env), { route: "/mcp" })(request, env, ctx);
  },
};

async function defaultHandler(request: Request, env: Env & { OAUTH_PROVIDER: any }, _ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/authorize" || path === "/callback") return handleAuthRequest(request, env);
  if (path === "/setup") return handleSetupRequest(request, env);
  if (path === "/healthz") return Response.json({ ok: true, service: "universal-caldav-calendar" });
  if (path === "/privacy") return new Response("CalDAV credentials are encrypted with AES-256-GCM and stored per authenticated user. Credentials are never returned by tools or logged intentionally.", { headers: { "content-type": "text/plain; charset=utf-8" } });
  if (path === "/terms") return new Response("Personal-use software provided as-is. You control the connected CalDAV account and can disconnect it at any time.", { headers: { "content-type": "text/plain; charset=utf-8" } });
  if (path === "/") return new Response("Universal CalDAV Calendar remote MCP. Connect at /mcp.", { headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response("Not Found", { status: 404 });
}

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  allowPlainPKCE: false,
  defaultHandler: { fetch: defaultHandler as any },
});
