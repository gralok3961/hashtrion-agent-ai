import { isIP } from "node:net";

import { safePublicUrl } from "./safe-http";

export type UcpProfile = {
  version: string;
  services: Array<{
    name: string;
    version: string;
    transport: string;
    endpoint?: string;
  }>;
  capabilities: Array<{ name: string; version: string }>;
  restEndpoints: Array<{ service: string; version: string; url: string }>;
};

const MAX_REGISTRY_NAMES = 32;
const MAX_ENTRIES = 64;
const MAX_NAME_LENGTH = 160;
const MAX_URL_LENGTH = 2_048;
const TRANSPORTS = ["rest", "mcp", "a2a", "embedded"] as const;
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;
// These published discovery contracts were reviewed individually. An arbitrary
// date is not evidence of a supported protocol: new releases need review before
// the application may mark their metadata as verified.
// https://ucp.dev/{2026-01-11,2026-04-08,2026-08-25}/specification/overview/
const SUPPORTED_PROTOCOL_VERSIONS = ["2026-01-11", "2026-04-08", "2026-08-25"];

function invalid(): never {
  // Never include untrusted profile data, URLs, or upstream details in errors.
  throw new Error("Invalid UCP discovery profile.");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid();
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.length || value.length > maxLength) {
    invalid();
  }
  return value;
}

function nameOf(value: unknown): string {
  const name = boundedString(value, MAX_NAME_LENGTH);
  if (!NAME_PATTERN.test(name)) {
    invalid();
  }
  return name;
}

function versionOf(value: unknown): string {
  const version = boundedString(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) {
    invalid();
  }
  const timestamp = Date.parse(`${version}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== version) {
    invalid();
  }
  return version;
}

function httpsUrl(value: unknown): URL {
  try {
    return safePublicUrl(boundedString(value, MAX_URL_LENGTH));
  } catch {
    invalid();
  }
}

export function authorityUrl(value: unknown, name: string): URL {
  const url = httpsUrl(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, "")) || host.split(".").length < 2) {
    invalid();
  }
  const authority = host.split(".").reverse().join(".");
  if (name !== authority && !name.startsWith(`${authority}.`)) {
    invalid();
  }
  return url;
}

function endpointUrl(value: unknown): string {
  const url = httpsUrl(value);
  // Only public base endpoints are surfaced. Query-bearing endpoints may hold
  // signed tokens or API credentials and are unsupported in discovery output.
  if (url.search) {
    invalid();
  }
  return url.href;
}

function entries(value: unknown): Array<[string, Record<string, unknown>]> {
  const registry = Object.entries(record(value));
  if (registry.length > MAX_REGISTRY_NAMES) {
    invalid();
  }
  const result: Array<[string, Record<string, unknown>]> = [];
  for (const [rawName, values] of registry) {
    const name = nameOf(rawName);
    if (!Array.isArray(values) || values.length > MAX_ENTRIES) {
      invalid();
    }
    for (const value of values) {
      if (result.length >= MAX_ENTRIES) {
        invalid();
      }
      result.push([name, record(value)]);
    }
  }
  return result;
}

function entity(
  value: Record<string, unknown>,
  name: string,
  profileVersion: string,
  options: { schemaRequired?: boolean; boundSpecRequired?: boolean } = {}
): string {
  const version = versionOf(value.version);
  // August's release requires UCP snapshot equality. January and April explicitly
  // allow independent UCP capability versions, so do not apply the newer rule.
  // https://ucp.dev/2026-04-08/specification/overview/#independent-component-versioning
  if (
    profileVersion === "2026-08-25" &&
    name.startsWith("dev.ucp.") &&
    version !== profileVersion
  ) {
    invalid();
  }
  if (value.config !== undefined) {
    record(value.config);
  }
  if (value.id !== undefined) {
    boundedString(value.id, MAX_NAME_LENGTH);
  }
  if (options.boundSpecRequired) {
    authorityUrl(value.spec, name);
  } else if (value.spec !== undefined) {
    httpsUrl(value.spec);
  }
  if (options.schemaRequired || value.schema !== undefined) {
    authorityUrl(value.schema, name);
  }
  return version;
}

function parentsOf(value: unknown, legacy = false): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    nameOf(value);
    return;
  }
  if (legacy || !Array.isArray(value) || value.length === 0 || value.length > MAX_REGISTRY_NAMES) {
    invalid();
  }
  for (const parent of value) {
    nameOf(parent);
  }
}

function addService(
  profile: UcpProfile,
  name: string,
  version: string,
  transport: string,
  binding: Record<string, unknown>
): void {
  if (profile.services.length >= MAX_ENTRIES) {
    invalid();
  }
  const endpoint =
    transport !== "embedded" || binding.endpoint !== undefined
      ? endpointUrl(binding.endpoint)
      : undefined;
  profile.services.push({ name, version, transport, ...(endpoint ? { endpoint } : {}) });
  if (transport === "rest" && endpoint) {
    profile.restEndpoints.push({ service: name, version, url: endpoint });
  }
}

function parseCurrent(ucp: Record<string, unknown>, profile: UcpProfile): void {
  // Business profiles differ from platform profiles: service spec/schema are
  // optional; REST/MCP/A2A endpoints and capability schema URLs are required.
  // https://ucp.dev/specification/overview/#profile-structure
  for (const [name, value] of entries(ucp.services)) {
    const version = entity(value, name, profile.version);
    const transport = boundedString(value.transport, 16);
    if (!TRANSPORTS.some((candidate) => candidate === transport)) {
      invalid();
    }
    addService(profile, name, version, transport, value);
  }
  for (const [name, value] of entries(ucp.capabilities === undefined ? {} : ucp.capabilities)) {
    const version = entity(value, name, profile.version, {
      schemaRequired: true,
      // April binds both spec and schema; August binds schema only and makes
      // business capability spec optional.
      boundSpecRequired: profile.version === "2026-04-08",
    });
    parentsOf(value.extends);
    profile.capabilities.push({ name, version });
  }
  // This registry is mandatory even when empty. Payment configuration is never
  // returned or activated: this parser only validates the discovery envelope.
  for (const [name, value] of entries(ucp.payment_handlers)) {
    entity(value, name, profile.version);
    boundedString(value.id, MAX_NAME_LENGTH);
  }
  if (ucp.supported_versions !== undefined) {
    const versions = Object.entries(record(ucp.supported_versions));
    if (versions.length > MAX_REGISTRY_NAMES) {
      invalid();
    }
    for (const [version, url] of versions) {
      if (versionOf(version) >= profile.version) {
        invalid();
      }
      httpsUrl(url);
    }
  }
}

function parseJanuary2026(ucp: Record<string, unknown>, profile: UcpProfile): void {
  // Explicit compatibility for the published 2026-01-11 shape only. Do not
  // reinterpret malformed modern registries as legacy declarations.
  // https://ucp.dev/2026-01-11/specification/overview/#business-profile
  const services = Object.entries(record(ucp.services));
  if (services.length > MAX_REGISTRY_NAMES) {
    invalid();
  }
  for (const [rawName, rawService] of services) {
    const name = nameOf(rawName);
    const service = record(rawService);
    const version = entity(service, name, profile.version, { boundSpecRequired: true });
    for (const transport of TRANSPORTS) {
      if (service[transport] === undefined) {
        continue;
      }
      const binding = record(service[transport]);
      if (transport !== "a2a" || binding.schema !== undefined) {
        authorityUrl(binding.schema, name);
      }
      addService(profile, name, version, transport, binding);
    }
  }
  if (!Array.isArray(ucp.capabilities) || ucp.capabilities.length > MAX_ENTRIES) {
    invalid();
  }
  for (const rawCapability of ucp.capabilities) {
    const value = record(rawCapability);
    const name = nameOf(value.name);
    const version = entity(value, name, profile.version, {
      boundSpecRequired: true,
      schemaRequired: true,
    });
    parentsOf(value.extends, true);
    profile.capabilities.push({ name, version });
  }
}

/**
 * Validate and project only discovery metadata from an HTTPS-fetched profile.
 * This does not authenticate a merchant, negotiate compatibility, validate
 * payment/key schemas, or probe any advertised service/schema/spec URL.
 */
export function parseUcpProfile(body: unknown): UcpProfile {
  const ucp = record(record(body).ucp);
  const version = versionOf(ucp.version);
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    invalid();
  }
  if (ucp.status !== undefined && ucp.status !== "success") {
    invalid();
  }
  const profile: UcpProfile = { version, services: [], capabilities: [], restEndpoints: [] };
  if (version === "2026-01-11") {
    parseJanuary2026(ucp, profile);
  } else {
    parseCurrent(ucp, profile);
  }
  return profile;
}
