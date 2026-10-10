import { isIP } from "node:net";

function normalizedIPAddress(value) {
  let candidate = String(value || "").trim();
  if (!candidate) return "";
  if (candidate.includes(",")) candidate = candidate.split(",")[0].trim();
  if (candidate.startsWith("::ffff:")) candidate = candidate.slice(7);
  if (candidate.startsWith("[") && candidate.includes("]")) candidate = candidate.slice(1, candidate.indexOf("]"));
  if (isIP(candidate)) return candidate;
  const ipv4WithPort = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return ipv4WithPort && isIP(ipv4WithPort[1]) ? ipv4WithPort[1] : "";
}

export function clientIPAddress(req, { onRender = process.env.RENDER === "true" } = {}) {
  // Render documents X-Forwarded-For as its client IP source. Other request
  // headers can be supplied by the caller and must not override that value.
  if (onRender) {
    const forwarded = req.headers?.["x-forwarded-for"];
    const address = normalizedIPAddress(Array.isArray(forwarded) ? forwarded[0] : forwarded);
    if (address) return address;
  }
  return normalizedIPAddress(req.socket?.remoteAddress);
}
