import { FSM_SOURCES, randomSecret, type FsmSource } from '@ccb/core-api';

export interface GatewayConfig {
  port: number;
  host: string;
  publicUrl: string;
  adminToken: string | null;
  appSecret: string;
  dataFile: string | null;
  sandbox: boolean;
  requireSignatures: boolean;
  fsm: Record<FsmSource, { webhookSecret: string; generated: boolean; accessToken?: string; graphqlEndpoint?: string }>;
  review: {
    enabled?: boolean;
    minSatisfaction?: number;
    cooldownDays?: number;
    minInvoiceCents?: number;
    delayMinutes?: number;
  };
  highValueThresholdCents: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
  ghl: {
    clientId?: string;
    clientSecret?: string;
    ssoSharedSecret?: string;
    actionSecret?: string;
    webhookPublicKey?: string;
    privateToken?: string;
    defaultLocationId?: string;
    locationMap?: Record<string, string>;
    apiBase?: string;
  };
  hubspot: { clientId?: string; clientSecret?: string; appId?: string; privateAppToken?: string; defaultPortalId?: string; apiBase?: string };
  pipedrive: { clientId?: string; clientSecret?: string; apiToken?: string; apiBase?: string; oauthBase?: string; panelUser?: string; panelPassword?: string };
  monday: { clientId?: string; clientSecret?: string; signingSecret?: string; apiToken?: string; boardId?: string; apiUrl?: string };
  make: { apiKeys: string[] };
}

type Env = Record<string, string | undefined>;

const ENV_PREFIX: Record<FsmSource, string> = {
  jobber: 'JOBBER',
  housecallpro: 'HCP',
  servicetitan: 'SERVICETITAN',
  fieldedge: 'FIELDEDGE',
  buildertrend: 'BUILDERTREND',
};

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${v}"`);
  return n;
}

function optNum(v: string | undefined): number | undefined {
  return v === undefined || v === '' ? undefined : num(v, 0);
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function opt(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v;
}

function jsonMap(v: string | undefined, name: string): Record<string, string> | undefined {
  if (!v) return undefined;
  try {
    return JSON.parse(v) as Record<string, string>;
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }
}

export function loadConfig(env: Env = process.env): GatewayConfig {
  const port = num(env.PORT, 8787);
  const host = env.HOST ?? '0.0.0.0';
  const sandbox = bool(env.SANDBOX, true);
  const fsm = {} as GatewayConfig['fsm'];
  for (const source of FSM_SOURCES) {
    const prefix = ENV_PREFIX[source];
    const configured = opt(env[`${prefix}_WEBHOOK_SECRET`]);
    fsm[source] = {
      webhookSecret: configured ?? randomSecret(),
      generated: !configured,
      ...(source === 'jobber' ? { accessToken: opt(env.JOBBER_ACCESS_TOKEN), graphqlEndpoint: opt(env.JOBBER_GRAPHQL_URL) } : {}),
    };
  }
  return {
    port,
    host,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    adminToken: opt(env.ADMIN_TOKEN) ?? null,
    appSecret: opt(env.APP_SECRET) ?? randomSecret(32),
    dataFile: opt(env.DATA_FILE) ?? null,
    sandbox,
    requireSignatures: bool(env.REQUIRE_SIGNATURES, true),
    fsm,
    review: {
      enabled: env.REVIEW_ENABLED === undefined ? undefined : bool(env.REVIEW_ENABLED, true),
      minSatisfaction: optNum(env.REVIEW_MIN_SATISFACTION),
      cooldownDays: optNum(env.REVIEW_COOLDOWN_DAYS),
      minInvoiceCents: optNum(env.REVIEW_MIN_INVOICE_CENTS),
      delayMinutes: optNum(env.REVIEW_DELAY_MINUTES),
    },
    highValueThresholdCents: num(env.HIGH_VALUE_THRESHOLD_CENTS, 50_000),
    retryAttempts: num(env.CRM_RETRY_ATTEMPTS, 3),
    retryBaseDelayMs: num(env.CRM_RETRY_BASE_DELAY_MS, 250),
    ghl: {
      clientId: opt(env.GHL_CLIENT_ID),
      clientSecret: opt(env.GHL_CLIENT_SECRET),
      ssoSharedSecret: opt(env.GHL_SSO_SECRET),
      actionSecret: opt(env.GHL_ACTION_SECRET),
      webhookPublicKey: opt(env.GHL_WEBHOOK_PUBLIC_KEY)?.replace(/\\n/g, '\n'),
      privateToken: opt(env.GHL_PRIVATE_TOKEN),
      defaultLocationId: opt(env.GHL_LOCATION_ID),
      locationMap: jsonMap(env.GHL_LOCATION_MAP, 'GHL_LOCATION_MAP'),
      apiBase: opt(env.GHL_API_BASE),
    },
    hubspot: {
      clientId: opt(env.HUBSPOT_CLIENT_ID),
      clientSecret: opt(env.HUBSPOT_CLIENT_SECRET),
      appId: opt(env.HUBSPOT_APP_ID),
      privateAppToken: opt(env.HUBSPOT_PRIVATE_APP_TOKEN),
      defaultPortalId: opt(env.HUBSPOT_PORTAL_ID),
      apiBase: opt(env.HUBSPOT_API_BASE),
    },
    pipedrive: {
      clientId: opt(env.PIPEDRIVE_CLIENT_ID),
      clientSecret: opt(env.PIPEDRIVE_CLIENT_SECRET),
      apiToken: opt(env.PIPEDRIVE_API_TOKEN),
      apiBase: opt(env.PIPEDRIVE_API_BASE),
      oauthBase: opt(env.PIPEDRIVE_OAUTH_BASE),
      panelUser: opt(env.PIPEDRIVE_PANEL_USER),
      panelPassword: opt(env.PIPEDRIVE_PANEL_PASSWORD),
    },
    monday: {
      clientId: opt(env.MONDAY_CLIENT_ID),
      clientSecret: opt(env.MONDAY_CLIENT_SECRET),
      signingSecret: opt(env.MONDAY_SIGNING_SECRET),
      apiToken: opt(env.MONDAY_API_TOKEN),
      boardId: opt(env.MONDAY_BOARD_ID),
      apiUrl: opt(env.MONDAY_API_URL),
    },
    make: { apiKeys: (env.MAKE_API_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean) },
  };
}
