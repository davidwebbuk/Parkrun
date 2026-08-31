const { XMLParser } = require("fast-xml-parser");

// National Rail Enquiries "OJP" (Online Journey Planner) Real Time Journey
// Planner Services - a SOAP 1.1 web service. See docs/RTJP_User_Guide.pdf
// (P82571002 Issue 10) for the full spec; this client implements just the
// RealtimeJourneyPlan operation, which is the one that matters here: a real
// multi-leg journey (with interchanges) between two stations, with both
// scheduled and real-time departure/arrival per leg.
//
// Required configuration (env vars - see .env.example):
//   OJP_ENDPOINT_URL  the SOAP endpoint (the <soap:address location> from
//                     the WSDL at http://ojp.nationalrail.co.uk/webservices/jpdlr.wsdl,
//                     or from the raildata.org.uk subscription page - NOT
//                     verified against a live account in this codebase, see
//                     README "Adding real timetables")
//   OJP_USERNAME / OJP_PASSWORD   HTTP Basic Auth credentials (the guide
//                     also allows IP allow-listing instead, but that's not
//                     practical for a server that could run anywhere)
//
// The guide states (section 5.2) that the operation to invoke is determined
// by the SOAP body content, not the SOAPAction header, so we send an empty
// SOAPAction rather than guessing its exact value.

const SOAPENV_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const JPDLR_NS = "http://www.thalesgroup.com/ojp/jpdlr";
const COMMON_NS = "http://www.thalesgroup.com/ojp/common";

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

function isConfigured() {
  return Boolean(process.env.OJP_ENDPOINT_URL && process.env.OJP_USERNAME && process.env.OJP_PASSWORD);
}

function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[c]));
}

/** `departBy` should be a Date; the API takes a local (station-timezone) ISO datetime without offset. */
function buildRealtimeJourneyPlanRequest({ originCRS, destinationCRS, departBy, directTrains = false }) {
  const departByStr = departBy.toISOString().replace(/\.\d{3}Z$/, "");
  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="${SOAPENV_NS}" xmlns:jps="${JPDLR_NS}" xmlns:com="${COMMON_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <jps:RealtimeJourneyPlanRequest>
      <jps:origin><com:stationCRS>${xmlEscape(originCRS)}</com:stationCRS></jps:origin>
      <jps:destination><com:stationCRS>${xmlEscape(destinationCRS)}</com:stationCRS></jps:destination>
      <jps:realtimeEnquiry>STANDARD</jps:realtimeEnquiry>
      <jps:outwardTime><jps:departBy>${xmlEscape(departByStr)}</jps:departBy></jps:outwardTime>
      <jps:directTrains>${directTrains}</jps:directTrains>
    </jps:RealtimeJourneyPlanRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Normalizes one <outwardJourney> element into a plain object. */
function normalizeJourney(j) {
  const legs = asArray(j.leg).map((leg) => ({
    origin: leg.origin,
    destination: leg.destination,
    mode: leg.mode,
    operator: leg.operator && (leg.operator.name || leg.operator.code),
    scheduledDeparture: leg.timetable?.scheduled?.departure,
    scheduledArrival: leg.timetable?.scheduled?.arrival,
    realtimeDeparture: leg.timetable?.realtime?.departure,
    realtimeArrival: leg.timetable?.realtime?.arrival,
  }));

  return {
    origin: j.origin,
    destination: j.destination,
    realtimeClassification: j.realtimeClassification,
    scheduledDeparture: j.timetable?.scheduled?.departure,
    scheduledArrival: j.timetable?.scheduled?.arrival,
    realtimeDeparture: j.timetable?.realtime?.departure,
    realtimeArrival: j.timetable?.realtime?.arrival,
    interchanges: Math.max(0, legs.length - 1),
    legs,
  };
}

/**
 * Calls RealtimeJourneyPlan and returns a list of normalized journey
 * options (both scheduled and, where available, real-time departure/arrival
 * per leg). Throws with a descriptive message on a SOAP fault or transport
 * error - callers should catch and fall back to the heuristic estimator.
 */
async function realtimeJourneyPlan({ originCRS, destinationCRS, departBy, directTrains }) {
  if (!isConfigured()) {
    throw new Error("OJP not configured: set OJP_ENDPOINT_URL, OJP_USERNAME, OJP_PASSWORD");
  }

  const body = buildRealtimeJourneyPlanRequest({ originCRS, destinationCRS, departBy, directTrains });
  const auth = Buffer.from(`${process.env.OJP_USERNAME}:${process.env.OJP_PASSWORD}`).toString("base64");

  const res = await fetch(process.env.OJP_ENDPOINT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "",
      Authorization: `Basic ${auth}`,
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OJP HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const parsed = parser.parse(text);
  const envelopeBody = parsed?.Envelope?.Body;
  if (!envelopeBody) {
    throw new Error("OJP response: unexpected SOAP envelope shape");
  }

  const fault = envelopeBody.RealtimeJourneyPlanFault;
  if (fault) {
    throw new Error(`OJP fault ${fault.response}: ${fault.responseDetails || ""}`);
  }

  const response = envelopeBody.RealtimeJourneyPlanResponse;
  if (!response || response.response !== "Ok") {
    throw new Error(`OJP response not Ok: ${JSON.stringify(response?.response)}`);
  }

  return asArray(response.outwardJourney).map(normalizeJourney);
}

module.exports = { isConfigured, realtimeJourneyPlan };
