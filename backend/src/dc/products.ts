/**
 * Everything that differs between Health and Motor policies. The rest of the
 * console (sessions, queue, batches, retries, reports) is shared.
 *
 * Both go through the same wrapper endpoint (/wrapper/create-quote), which routes
 * on the policy-number prefix:
 *  - Health (2856…): one DuckCreek call; the wrapper returns a short summary
 *    ({ quote_number, premium, is_premium_matched, … }); one api_logs row per attempt.
 *  - Motor (2302…): Blaze rating call, then DuckCreek create-quote; the wrapper
 *    returns DuckCreek's whole `session` object; two api_logs rows per attempt.
 */

export type Product = 'health' | 'motor';
export const PRODUCTS: Product[] = ['health', 'motor'];

export const PRODUCT_INFO: Record<Product, { label: string; prefix: string }> = {
  health: { label: 'Health', prefix: '2856' },
  motor: { label: 'Motor', prefix: '2302' },
};

export const isProduct = (p: unknown): p is Product => p === 'health' || p === 'motor';

/** Product a policy number belongs to (by prefix), if any. */
export function productOf(policy: string): Product | undefined {
  return PRODUCTS.find((p) => policy.startsWith(PRODUCT_INFO[p].prefix));
}

/** Quote fields pulled out of a successful-looking wrapper response. */
export interface QuoteFields {
  quoteNumber?: string;
  /** Gross premium (Motor: policy.line.Premium = PurePremium + TaxesSurcharges). */
  premium?: string;
  purePremium?: string;
  taxes?: string;
  discount?: string;
  quoteId?: string;
  imdCode?: string;
  cohortType?: string;
  quoteGeneratedDate?: string;
  /** Health only: the wrapper's own GC-vs-DC premium comparison ("1"/"0"). */
  isPremiumMatched?: string;
}

const str = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : String(v));

export function parseQuoteFields(product: Product, resp: any): QuoteFields {
  if (product === 'health') {
    const d = resp?.data ?? {};
    return {
      quoteNumber: str(d.quote_number),
      premium: str(d.premium),
      purePremium: str(d.pure_premium),
      taxes: str(d.quote_taxes),
      discount: str(d.quote_discount),
      quoteId: str(d.quote_id),
      imdCode: str(d.imd_code),
      cohortType: str(d.cohort_type),
      quoteGeneratedDate: str(d.quote_generated_date),
      isPremiumMatched: str(d.is_premium_matched),
    };
  }
  // Motor: same paths the wrapper uses in insertRenewalQuoteData().
  const session = resp?.data?.session;
  const data = session?.data;
  const policy = data?.policy;
  const line = policy?.line;
  return {
    quoteNumber: str(policy?.QuoteNumber),
    premium: str(line?.Premium),
    purePremium: str(line?.PurePremium),
    taxes: str(line?.TaxesSurcharges),
    discount: str(line?.TotalDiscountAmount),
    quoteId: str(session?.['@id'] ?? session?.id),
    imdCode: str(data?.DistributionDetails?.IMD_CODE),
    cohortType: str(data?.account?.CohortType),
    quoteGeneratedDate: str(policy?.QuoteGeneratedDate),
  };
}

// ---------------------------------------------------------------- api_logs payloads

/** One payload slot per product: Health has request/response; Motor has Blaze + DuckCreek pairs. */
export const PAYLOAD_KINDS: Record<Product, string[]> = {
  health: ['request', 'response'],
  motor: ['dc_request', 'dc_response', 'blaze_request', 'blaze_response'],
};

/** Where a product's payload files go, relative to the payloads dir (Health stays at the root). */
export const PAYLOAD_SUBDIR: Record<Product, string> = { health: '', motor: 'motor' };

export function payloadFileName(product: Product, policy: string, kind: string, ext: 'json' | 'txt'): string {
  const name = product === 'health' ? `${policy}_${kind}_payload.${ext}` : `${policy}_${kind}.${ext}`;
  return PAYLOAD_SUBDIR[product] ? `${PAYLOAD_SUBDIR[product]}/${name}` : name;
}

/** Files we write (payloads + offloaded quote responses); also blocks path traversal. */
export const SERVED_FILE = /^(motor\/)?\d+_[a-z_]+\.(json|txt)$/;

/**
 * SQL returning one JSON line for the policy's api_logs rows.
 * Health: the two "latest row" queries from the manual workflow.
 * Motor: the latest few rows with their endpoint, so the Blaze and DuckCreek rows
 * of the same attempt can be told apart.
 */
export function payloadSql(product: Product, table: string, policy: string): string {
  if (product === 'health') {
    const latest = (col: string) =>
      `(select ${col} from ${table} where policy_number='${policy}' order by created_at desc limit 1)`;
    return `select json_build_object('request', ${latest('external_request')}, 'response', ${latest('external_response')});`;
  }
  return (
    `select coalesce(json_agg(r order by r.created_at desc), '[]'::json) from (` +
    `select api_endpoint, status::text as status, created_at, external_request, external_response ` +
    `from ${table} where policy_number='${policy}' order by created_at desc limit 6) r;`
  );
}

interface MotorRow {
  api_endpoint?: string;
  status?: string;
  created_at?: string;
  external_request?: unknown;
  external_response?: unknown;
}

/** Columns hold JSON as text, sometimes double-encoded: unwrap until it's not a string. */
export function deepJson(value: unknown): unknown {
  while (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

function isBlazeRow(r: MotorRow): boolean {
  if (/blaze/i.test(r.api_endpoint ?? '')) return true;
  if (/create-?quote|duck/i.test(r.api_endpoint ?? '')) return false;
  // Fall back to the payload shape: DuckCreek requests are { session: … }.
  const req = deepJson(r.external_request) as any;
  return !(req && typeof req === 'object' && 'session' in req);
}

export interface PayloadRows {
  /** kind → value (null when the slot is empty for the latest attempt). */
  values: Record<string, unknown>;
  /** Short note about which rows were used (Motor). */
  note?: string;
  /** Motor: the latest attempt's Blaze call has a row but DuckCreek doesn't. */
  dcMissing?: boolean;
}

/** Turn the psql output into payload slots for the product. */
export function splitPayloadRows(product: Product, raw: string): PayloadRows {
  const parsed = JSON.parse(raw);
  if (product === 'health') {
    return { values: { request: parsed?.request ?? null, response: parsed?.response ?? null } };
  }
  const rows = (Array.isArray(parsed) ? parsed : []) as MotorRow[];
  const values: Record<string, unknown> = { dc_request: null, dc_response: null, blaze_request: null, blaze_response: null };
  if (!rows.length) return { values };

  // Rows are newest first. The newest row decides the attempt:
  //  - DuckCreek row: pair it with the Blaze row logged just before it.
  //  - Blaze row: DuckCreek wasn't reached (or not logged) in the latest attempt.
  const latest = rows[0];
  if (isBlazeRow(latest)) {
    values.blaze_request = latest.external_request ?? null;
    values.blaze_response = latest.external_response ?? null;
    return { values, dcMissing: true, note: `latest attempt: Blaze only (${latest.status ?? 'unknown status'})` };
  }
  values.dc_request = latest.external_request ?? null;
  values.dc_response = latest.external_response ?? null;
  const blaze = rows.slice(1).find(isBlazeRow);
  if (blaze) {
    values.blaze_request = blaze.external_request ?? null;
    values.blaze_response = blaze.external_response ?? null;
  }
  return { values, note: `latest attempt: DuckCreek ${latest.status ?? ''}${blaze ? ` + Blaze ${blaze.status ?? ''}` : ' (no Blaze row found)'}` };
}

/** Which saved payload to read for the "what did DuckCreek/Blaze actually say" summary, in order. */
export const ERROR_SOURCE_KINDS = ['response', 'dc_response', 'blaze_response'];
