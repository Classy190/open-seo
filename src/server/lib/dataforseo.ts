import {
  DataforseoLabsApi,
  DataforseoLabsGoogleRelatedKeywordsLiveRequestInfo,
  DataforseoLabsGoogleKeywordSuggestionsLiveRequestInfo,
  DataforseoLabsGoogleKeywordIdeasLiveRequestInfo,
  DataforseoLabsGoogleDomainRankOverviewLiveRequestInfo,
  DataforseoLabsGoogleRankedKeywordsLiveRequestInfo,
} from "dataforseo-client";
import { env } from "cloudflare:workers";
import { getDomain } from "tldts";
import { AppError } from "@/server/lib/errors";
import {
  dataforseoResponseSchema,
  domainMetricsItemSchema,
  domainRankedKeywordItemSchema,
  labsKeywordDataItemSchema,
  parseTaskItems,
  relatedKeywordItemSchema,
  serpSnapshotItemSchema,
  type DataforseoTask,
  type DomainMetricsItem,
  type DomainRankedKeywordItem,
  type LabsKeywordDataItem,
  type RelatedKeywordItem,
  type SerpLiveItem,
} from "@/server/lib/dataforseoSchemas";
export type {
  DomainRankedKeywordItem,
  LabsKeywordDataItem,
  SerpLiveItem,
} from "@/server/lib/dataforseoSchemas";

// ---------------------------------------------------------------------------
// SDK client factories (lazily created per-request using the env secret)
// ---------------------------------------------------------------------------

function createAuthenticatedFetch() {
  return (url: RequestInfo, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Basic ${env.DATAFORSEO_API_KEY}`);

    const newInit: RequestInit = {
      ...init,
      headers,
    };
    return fetch(url, newInit);
  };
}

const API_BASE = "https://api.dataforseo.com";
const useMockProvider = !Boolean(env.DATAFORSEO_API_KEY?.trim());

function getLabsApi() {
  return new DataforseoLabsApi(API_BASE, { fetch: createAuthenticatedFetch() });
}

const MOCK_KEYWORD_TRENDS = [
  { year: 2024, month: 1, search_volume: 320 },
  { year: 2024, month: 2, search_volume: 410 },
  { year: 2024, month: 3, search_volume: 460 },
  { year: 2024, month: 4, search_volume: 530 },
  { year: 2024, month: 5, search_volume: 590 },
];

function makeMockKeywordInfo(keyword: string) {
  return {
    search_volume: 520,
    cpc: 1.35,
    competition: 0.42,
    monthly_searches: MOCK_KEYWORD_TRENDS,
  };
}

function makeMockKeywordDataItem(keyword: string) {
  return {
    keyword,
    keyword_info: makeMockKeywordInfo(keyword),
    keyword_info_normalized_with_clickstream: makeMockKeywordInfo(keyword),
    search_intent_info: { main_intent: "commercial" },
    keyword_properties: { keyword_difficulty: 34 },
  };
}

function makeMockRelatedKeywordItem(keyword: string) {
  return {
    keyword_data: {
      keyword,
      keyword_info: makeMockKeywordInfo(keyword),
      keyword_info_normalized_with_clickstream: makeMockKeywordInfo(keyword),
      search_intent_info: { main_intent: "informational" },
      keyword_properties: { keyword_difficulty: 28 },
    },
  };
}

function makeMockDomainMetricsItem() {
  return {
    metrics: {
      organic: {
        etv: 120.5,
        count: 38,
      },
    },
  };
}

function makeMockRankedKeywordItem(target: string, index: number) {
  const keyword = `${target} example keyword ${index + 1}`;
  const url = `https://${target.replace(/[^a-zA-Z0-9]/g, "")}.example.com/page-${index + 1}`;

  return {
    keyword_data: {
      keyword,
      keyword_info: {
        search_volume: 420 - index * 20,
        cpc: 0.95 + index * 0.1,
        keyword_difficulty: 30 + index * 2,
      },
      keyword_properties: {
        keyword_difficulty: 30 + index * 2,
      },
    },
    ranked_serp_element: {
      serp_item: {
        url,
        relative_url: `/page-${index + 1}`,
        rank_absolute: index + 1,
        etv: 18 - index * 2,
      },
      url,
      relative_url: `/page-${index + 1}`,
      rank_absolute: index + 1,
      etv: 18 - index * 2,
    },
    keyword,
    rank_absolute: index + 1,
    etv: 18 - index * 2,
  };
}

function makeMockSerpItems(keyword: string) {
  return [
    {
      type: "organic",
      rank_absolute: 1,
      domain: "example.com",
      title: `Best ${keyword} guide`,
      url: `https://example.com/${keyword.replace(/\s+/g, "-")}`,
      description: `A helpful mock result for ${keyword}.`,
      etv: 28,
      estimated_paid_traffic_cost: 12.5,
      backlinks_info: {
        referring_domains: 14,
        backlinks: 58,
      },
      rank_changes: {
        previous_rank_absolute: 2,
        is_new: false,
        is_up: true,
        is_down: false,
      },
    },
    {
      type: "organic",
      rank_absolute: 2,
      domain: "example.org",
      title: `${keyword} resources`,
      url: `https://example.org/${keyword.replace(/\s+/g, "-")}`,
      description: `More mock content for ${keyword}.`,
      etv: 16,
      estimated_paid_traffic_cost: 4.2,
      backlinks_info: {
        referring_domains: 9,
        backlinks: 24,
      },
      rank_changes: {
        previous_rank_absolute: 3,
        is_new: false,
        is_up: true,
        is_down: false,
      },
    },
  ];
}

async function postDataforseo(
  path: string,
  payload: unknown,
): Promise<unknown> {
  const authenticatedFetch = createAuthenticatedFetch();
  const response = await authenticatedFetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new AppError(
      "INTERNAL_ERROR",
      `DataForSEO HTTP ${response.status} on ${path}`,
    );
  }

  return await response.json();
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Validate that the top-level response and first task both succeeded.
 * Throws a descriptive error on failure. Returns the first task.
 */
function assertOk<T extends { status_code?: number; status_message?: string }>(
  response: {
    status_code?: number;
    status_message?: string;
    tasks?: T[];
  } | null,
): T {
  if (!response) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO returned an empty response",
    );
  }
  if (response.status_code !== 20000) {
    throw new AppError(
      "INTERNAL_ERROR",
      response.status_message || "DataForSEO request failed",
    );
  }
  const task = response.tasks?.[0];
  if (!task) {
    throw new AppError("INTERNAL_ERROR", "DataForSEO response missing task");
  }
  if (task.status_code !== 20000) {
    throw new AppError(
      "INTERNAL_ERROR",
      task.status_message || "DataForSEO task failed",
    );
  }
  return task;
}

// ---------------------------------------------------------------------------
// DataForSEO Labs API wrappers
// ---------------------------------------------------------------------------

export async function fetchRelatedKeywordsRaw(
  keyword: string,
  locationCode: number,
  languageCode: string,
  limit: number,
  depth: number = 3,
): Promise<RelatedKeywordItem[]> {
  if (useMockProvider) {
    const results: RelatedKeywordItem[] = [];
    for (let i = 0; i < Math.min(limit, 10); i += 1) {
      results.push(makeMockRelatedKeywordItem(`${keyword} related ${i + 1}`));
    }
    return results;
  }

  const api = getLabsApi();
  const req = new DataforseoLabsGoogleRelatedKeywordsLiveRequestInfo({
    keyword,
    location_code: locationCode,
    language_code: languageCode,
    limit,
    depth,
    include_clickstream_data: true,
    include_serp_info: false,
  });

  const response = await api.googleRelatedKeywordsLive([req]);
  const task = assertOk<DataforseoTask>(response);
  return parseTaskItems(
    "google-related-keywords-live",
    task,
    relatedKeywordItemSchema,
  );
}

export async function fetchKeywordSuggestionsRaw(
  keyword: string,
  locationCode: number,
  languageCode: string,
  limit: number,
): Promise<LabsKeywordDataItem[]> {
  if (useMockProvider) {
    return Array.from({ length: Math.min(limit, 10) }, (_, index) =>
      makeMockKeywordDataItem(`${keyword} suggestion ${index + 1}`),
    );
  }

  const api = getLabsApi();
  const req = new DataforseoLabsGoogleKeywordSuggestionsLiveRequestInfo({
    keyword,
    location_code: locationCode,
    language_code: languageCode,
    limit,
    include_clickstream_data: true,
    include_serp_info: false,
    include_seed_keyword: true,
    ignore_synonyms: false,
    exact_match: false,
  });

  const response = await api.googleKeywordSuggestionsLive([req]);
  const task = assertOk<DataforseoTask>(response);
  return parseTaskItems(
    "google-keyword-suggestions-live",
    task,
    labsKeywordDataItemSchema,
  );
}

export async function fetchKeywordIdeasRaw(
  keyword: string,
  locationCode: number,
  languageCode: string,
  limit: number,
): Promise<LabsKeywordDataItem[]> {
  if (useMockProvider) {
    return Array.from({ length: Math.min(limit, 10) }, (_, index) =>
      makeMockKeywordDataItem(`${keyword} idea ${index + 1}`),
    );
  }

  const api = getLabsApi();
  const req = new DataforseoLabsGoogleKeywordIdeasLiveRequestInfo({
    keywords: [keyword],
    location_code: locationCode,
    language_code: languageCode,
    limit,
    include_clickstream_data: true,
    include_serp_info: false,
    ignore_synonyms: false,
    closely_variants: false,
  });

  const response = await api.googleKeywordIdeasLive([req]);
  const task = assertOk<DataforseoTask>(response);
  return parseTaskItems(
    "google-keyword-ideas-live",
    task,
    labsKeywordDataItemSchema,
  );
}

// ---------------------------------------------------------------------------
// Domain API wrappers
// ---------------------------------------------------------------------------

export async function fetchDomainRankOverviewRaw(
  target: string,
  locationCode: number,
  languageCode: string,
): Promise<DomainMetricsItem[]> {
  if (useMockProvider) {
    return [makeMockDomainMetricsItem()];
  }

  const api = getLabsApi();
  const req = new DataforseoLabsGoogleDomainRankOverviewLiveRequestInfo({
    target,
    location_code: locationCode,
    language_code: languageCode,
    limit: 1,
  });

  const response = await api.googleDomainRankOverviewLive([req]);
  const task = assertOk<DataforseoTask>(response);
  return parseTaskItems(
    "google-domain-rank-overview-live",
    task,
    domainMetricsItemSchema,
  );
}

export async function fetchRankedKeywordsRaw(
  target: string,
  locationCode: number,
  languageCode: string,
  limit: number,
  orderBy?: string[],
): Promise<DomainRankedKeywordItem[]> {
  if (useMockProvider) {
    return Array.from({ length: Math.min(limit, 10) }, (_, index) =>
      makeMockRankedKeywordItem(target, index),
    );
  }

  const api = getLabsApi();
  const req = new DataforseoLabsGoogleRankedKeywordsLiveRequestInfo({
    target,
    location_code: locationCode,
    language_code: languageCode,
    limit,
    order_by: orderBy,
  });

  const response = await api.googleRankedKeywordsLive([req]);
  const task = assertOk<DataforseoTask>(response);
  return parseTaskItems(
    "google-ranked-keywords-live",
    task,
    domainRankedKeywordItemSchema,
  );
}

// ---------------------------------------------------------------------------
// SERP Analysis API wrapper (Google Organic Live)
// ---------------------------------------------------------------------------

export async function fetchLiveSerpItemsRaw(
  keyword: string,
  locationCode: number,
  languageCode: string,
): Promise<SerpLiveItem[]> {
  if (useMockProvider) {
    return makeMockSerpItems(keyword);
  }

  const responseRaw = await postDataforseo(
    "/v3/serp/google/organic/live/advanced",
    [
      {
        keyword,
        location_code: locationCode,
        language_code: languageCode,
        device: "desktop",
        os: "windows",
        depth: 100,
      },
    ],
  );
  const response = dataforseoResponseSchema.parse(responseRaw);
  const task = assertOk<DataforseoTask>(response);
  return parseTaskItems(
    "google-organic-live-advanced",
    task,
    serpSnapshotItemSchema,
  );
}

// ---------------------------------------------------------------------------
// Domain utility functions (unchanged)
// ---------------------------------------------------------------------------

export function toRelativePath(url: string | null | undefined): string | null {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return null;
  }
}

export function normalizeDomainInput(
  input: string,
  includeSubdomains: boolean,
): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    throw new AppError("VALIDATION_ERROR", "Domain is required");
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let host: string;
  try {
    host = new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    throw new AppError("VALIDATION_ERROR", "Domain is invalid");
  }

  if (!host) {
    throw new AppError("VALIDATION_ERROR", "Domain is invalid");
  }

  if (includeSubdomains) {
    return host;
  }

  return getDomain(host) ?? host;
}
