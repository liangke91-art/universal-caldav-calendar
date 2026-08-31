import { XMLParser } from "fast-xml-parser";
import type { CalendarCredentials } from "./credentials";

export type CalDavCalendar = { name: string; url: string };
export type CalDavResource = { href: string; etag?: string; ics: string };

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: false,
});

function array<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value && typeof value === "object" && "#text" in value) return text((value as Record<string, unknown>)["#text"]);
  return "";
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

type MultiStatusItem = { href: string; properties: Record<string, any> };

function parseMultiStatus(xml: string): MultiStatusItem[] {
  const document = parser.parse(xml) as Record<string, any>;
  const multistatus = document.multistatus ?? document["D:multistatus"] ?? document;
  return array<Record<string, any>>(multistatus.response).map((response) => {
    const properties: Record<string, any> = {};
    for (const propstat of array<Record<string, any>>(response.propstat)) {
      if (!text(propstat.status).includes(" 200 ")) continue;
      Object.assign(properties, propstat.prop ?? {});
    }
    return { href: text(response.href), properties };
  });
}

function propertyHref(property: unknown): string {
  if (!property || typeof property !== "object") return "";
  return text((property as Record<string, unknown>).href);
}

export class CalDavClient {
  constructor(private readonly credentials: CalendarCredentials) {}

  private async request(
    method: string,
    url: string,
    body?: string,
    headers: Record<string, string> = {},
    redirects = 0,
  ): Promise<Response> {
    const response = await fetch(url, {
      method,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(25_000),
      headers: {
        authorization: basicAuth(this.credentials.username, this.credentials.password),
        "content-type": "application/xml; charset=utf-8",
        "user-agent": "Universal-CalDAV-Calendar/0.1",
        ...headers,
      },
    });
    if ([301, 302, 307, 308].includes(response.status) && redirects < 3) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`CalDAV redirect ${response.status} has no location.`);
      const from = new URL(url);
      const target = new URL(location, from);
      if (target.protocol !== "https:" || target.hostname !== from.hostname) {
        throw new Error("CalDAV refused a cross-host or non-HTTPS redirect.");
      }
      return this.request(method, target.toString(), body, headers, redirects + 1);
    }
    if (!response.ok && response.status !== 207) {
      throw new Error(`CalDAV request failed with HTTP ${response.status}.`);
    }
    return response;
  }

  private async propfind(url: string, depth: "0" | "1", properties: string): Promise<MultiStatusItem[]> {
    const body = `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop>${properties}</D:prop></D:propfind>`;
    const response = await this.request("PROPFIND", url, body, { depth });
    return parseMultiStatus(await response.text());
  }

  async discoverCalendars(): Promise<CalDavCalendar[]> {
    const root = this.credentials.serverUrl;
    const requested = "<D:current-user-principal/><C:calendar-home-set/><D:displayname/><D:resourcetype/>";
    const rootItems = await this.propfind(root, "0", requested);
    const rootProps = rootItems[0]?.properties ?? {};
    let homeHref = propertyHref(rootProps["calendar-home-set"]);
    const principalHref = propertyHref(rootProps["current-user-principal"]);
    if (!homeHref && principalHref) {
      const principalUrl = new URL(principalHref, root).toString();
      const principalItems = await this.propfind(principalUrl, "0", "<C:calendar-home-set/><D:displayname/>");
      homeHref = propertyHref(principalItems[0]?.properties["calendar-home-set"]);
    }
    if (!homeHref) throw new Error("CalDAV discovery did not return a calendar-home-set.");
    const homeUrl = new URL(homeHref, root).toString();
    const items = await this.propfind(
      homeUrl,
      "1",
      "<D:displayname/><D:resourcetype/><C:supported-calendar-component-set/>",
    );
    const calendars = items
      .filter((item) => {
        const resourceType = item.properties.resourcetype;
        return resourceType && typeof resourceType === "object" && "calendar" in resourceType;
      })
      .map((item) => ({
        name: text(item.properties.displayname) || decodeURIComponent(item.href.replace(/\/$/, "").split("/").pop() || "Calendar"),
        url: new URL(item.href, homeUrl).toString(),
      }));
    if (!calendars.length) throw new Error("No CalDAV calendars were found for this account.");
    return calendars;
  }

  async selectCalendar(name?: string): Promise<CalDavCalendar> {
    const calendars = await this.discoverCalendars();
    const requested = (name || this.credentials.defaultCalendar || "").trim().toLocaleLowerCase();
    if (requested) {
      const found = calendars.find(
        (calendar) => calendar.name.toLocaleLowerCase() === requested || calendar.url.replace(/\/$/, "").toLocaleLowerCase() === requested.replace(/\/$/, ""),
      );
      if (!found) throw new Error(`Calendar '${name || this.credentials.defaultCalendar}' was not found.`);
      return found;
    }
    if (calendars.length !== 1) throw new Error("More than one calendar exists. Choose a calendar name or set a default.");
    return calendars[0];
  }

  async queryEvents(calendarUrl: string, start: string, end: string, expand = true): Promise<CalDavResource[]> {
    const parseResources = (xml: string): CalDavResource[] => parseMultiStatus(xml)
      .map((item) => ({
        href: new URL(item.href, calendarUrl).toString(),
        etag: text(item.properties.getetag) || undefined,
        ics: text(item.properties["calendar-data"]),
      }))
      .filter((item) => item.ics.includes("BEGIN:VEVENT"));

    const expandElement = expand ? `<C:expand start="${xmlEscape(start)}" end="${xmlEscape(end)}"/>` : "";
    const report = async (eventFilter: string, calendarData = expandElement): Promise<CalDavResource[]> => {
      const body = `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data>${calendarData}</C:calendar-data></D:prop><C:filter><C:comp-filter name="VCALENDAR">${eventFilter}</C:comp-filter></C:filter></C:calendar-query>`;
      const response = await this.request("REPORT", calendarUrl, body, { depth: "1" });
      return parseResources(await response.text());
    };

    // RFC 4791 time-range queries are the efficient path. Some otherwise valid
    // CalDAV servers (including fruux deployments) occasionally return an empty
    // multistatus for this filter even though UID queries and writes work. Retry
    // with an unbounded VEVENT query and keep expansion requested; CalendarService
    // applies the requested interval again locally so the public result stays exact.
    const ranged = await report(
      `<C:comp-filter name="VEVENT"><C:time-range start="${xmlEscape(start)}" end="${xmlEscape(end)}"/></C:comp-filter>`,
    );
    if (ranged.length) return ranged;

    const expandedFallback = await report('<C:comp-filter name="VEVENT"/>');
    if (expandedFallback.length) return expandedFallback;

    // A final raw-data fallback covers servers that support calendar-query but
    // reject the optional calendar-data/expand extension.
    const rawFallback = await report('<C:comp-filter name="VEVENT"/>', "");
    if (rawFallback.length) return rawFallback;

    // fruux and a few other servers can accept UID-filtered REPORT requests yet
    // return an empty response for broader calendar-query filters. Enumerate the
    // WebDAV collection and retrieve its members with calendar-multiget instead.
    // CalendarService applies the requested time interval locally afterwards.
    const collectionUrl = new URL(calendarUrl).toString().replace(/\/$/, "");
    let members = (await this.propfind(calendarUrl, "1", "<D:getetag/><D:resourcetype/>"))
      .map((item) => ({
        href: item.href,
        url: new URL(item.href, calendarUrl).toString(),
        resourceType: item.properties.resourcetype,
      }))
      .filter((item) => {
        if (!item.href || item.url.replace(/\/$/, "") === collectionUrl) return false;
        return !(item.resourceType && typeof item.resourceType === "object" && "collection" in item.resourceType);
      });
    if (!members.length) {
      try {
        const syncBody = `<?xml version="1.0" encoding="utf-8"?><D:sync-collection xmlns:D="DAV:"><D:sync-token/><D:sync-level>1</D:sync-level><D:prop><D:getetag/><D:resourcetype/></D:prop></D:sync-collection>`;
        const syncResponse = await this.request("REPORT", calendarUrl, syncBody, { depth: "1" });
        members = parseMultiStatus(await syncResponse.text())
          .map((item) => ({
            href: item.href,
            url: new URL(item.href, calendarUrl).toString(),
            resourceType: item.properties.resourcetype,
          }))
          .filter((item) => {
            if (!item.href || item.url.replace(/\/$/, "") === collectionUrl) return false;
            return !(item.resourceType && typeof item.resourceType === "object" && "collection" in item.resourceType);
          });
      } catch {
        // sync-collection is an optional compatibility fallback. Continue to
        // the empty multiget result when the server does not implement it.
      }
    }

    const resources: CalDavResource[] = [];
    for (let index = 0; index < members.length; index += 40) {
      const chunk = members.slice(index, index + 40);
      const hrefs = chunk.map((item) => `<D:href>${xmlEscape(new URL(item.url).pathname)}</D:href>`).join("");
      const body = `<?xml version="1.0" encoding="utf-8"?><C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop>${hrefs}</C:calendar-multiget>`;
      const response = await this.request("REPORT", calendarUrl, body, { depth: "1" });
      const parsed = parseResources(await response.text());
      resources.push(...parsed);
    }
    return resources;
  }

  async findEventByUid(uid: string, calendars?: CalDavCalendar[]): Promise<{ calendar: CalDavCalendar; resource: CalDavResource }> {
    const targets = calendars ?? (await this.discoverCalendars());
    const body = `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:prop-filter name="UID"><C:text-match collation="i;octet">${xmlEscape(uid)}</C:text-match></C:prop-filter></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
    for (const calendar of targets) {
      const response = await this.request("REPORT", calendar.url, body, { depth: "1" });
      const resource = parseMultiStatus(await response.text())
        .map((item) => ({ href: new URL(item.href, calendar.url).toString(), etag: text(item.properties.getetag) || undefined, ics: text(item.properties["calendar-data"]) }))
        .find((item) => item.ics.includes("BEGIN:VEVENT"));
      if (resource) return { calendar, resource };
    }
    throw new Error(`Event UID '${uid}' was not found.`);
  }

  async createEvent(calendarUrl: string, uid: string, ics: string): Promise<CalDavResource> {
    const resourceUrl = new URL(`${encodeURIComponent(uid)}.ics`, calendarUrl.endsWith("/") ? calendarUrl : `${calendarUrl}/`).toString();
    const response = await this.request("PUT", resourceUrl, ics, {
      "content-type": "text/calendar; charset=utf-8",
      "if-none-match": "*",
    });
    return { href: resourceUrl, etag: response.headers.get("etag") || undefined, ics };
  }

  async updateEvent(resource: CalDavResource, ics: string): Promise<CalDavResource> {
    const headers: Record<string, string> = { "content-type": "text/calendar; charset=utf-8" };
    if (resource.etag) headers["if-match"] = resource.etag;
    const response = await this.request("PUT", resource.href, ics, headers);
    return { href: resource.href, etag: response.headers.get("etag") || undefined, ics };
  }

  async deleteEvent(resource: CalDavResource): Promise<void> {
    const headers: Record<string, string> = {};
    if (resource.etag) headers["if-match"] = resource.etag;
    await this.request("DELETE", resource.href, undefined, headers);
  }
}

export function toCalDavTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid ISO date-time '${iso}'.`);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
