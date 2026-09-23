import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * mts-content-read — Secure Published Content Read Edge Function
 *
 * Authenticates MTS workstation installations using their verified
 * installation credential (same mechanism as mts-candidate-lifecycle-write),
 * then returns the current published content for a requested domain.
 *
 * Security boundary:
 * - Receives installation credential as Bearer token.
 * - Hashes and verifies via verify_mts_installation_credential (service_role only).
 * - Reads published content via get_published_content (service_role only).
 * - Never exposes service_role credentials to the caller.
 * - No anonymous or unauthenticated access.
 *
 * Supported domains: 'callers', 'discord_posts'
 */

interface ContentRequest {
  domain?: string;
}

const SUPPORTED_DOMAINS = new Set(["callers", "discord_posts"]);

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token.trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "Method not allowed. Only POST is accepted." }),
      { status: 405, headers: corsHeaders }
    );
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ ok: false, error: "Hosted service configuration is missing." }),
        { status: 500, headers: corsHeaders }
      );
    }

    // 1. Extract Bearer token (installation credential)
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!bearerToken) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "MISSING_CREDENTIAL",
          error: "Unauthorized: Missing Authorization Bearer token.",
        }),
        { status: 401, headers: corsHeaders }
      );
    }

    // 2. Parse request body
    let body: ContentRequest = {};
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid request body." }),
        { status: 400, headers: corsHeaders }
      );
    }

    const domain = String(body.domain || "").trim().toLowerCase();
    if (!domain) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "MISSING_DOMAIN",
          error: "Request body must include a 'domain' field.",
        }),
        { status: 400, headers: corsHeaders }
      );
    }

    if (!SUPPORTED_DOMAINS.has(domain)) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "UNSUPPORTED_DOMAIN",
          error: `Unsupported content domain. Supported: ${[...SUPPORTED_DOMAINS].join(", ")}`,
        }),
        { status: 400, headers: corsHeaders }
      );
    }

    // 3. Create service-role client
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // 4. Verify installation credential
    const tokenHash = await hashToken(bearerToken);
    const { data: instVerifyResult, error: instRpcError } = await adminClient
      .schema("mts_sam")
      .rpc("verify_mts_installation_credential", {
        p_credential_hash: tokenHash,
      });

    if (instRpcError) {
      console.error("[mts-content-read] Installation verify RPC failed:", instRpcError.message);
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "INTERNAL_ERROR",
          error: "Failed to verify installation credential.",
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    if (!instVerifyResult || !instVerifyResult.ok) {
      const errorCode = instVerifyResult?.error_code || "UNAUTHORIZED";
      const isRevokedOrInactive =
        errorCode === "INSTALLATION_REVOKED" || errorCode === "INSTALLATION_INACTIVE";
      const statusCode = isRevokedOrInactive ? 403 : 401;
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: errorCode,
          error: instVerifyResult?.error || "Unauthorized: Invalid or unrecognized installation credential.",
        }),
        { status: statusCode, headers: corsHeaders }
      );
    }

    const installationId = instVerifyResult.installation_id;

    // 5. Read published content via service_role RPC
    const { data: contentResult, error: contentRpcError } = await adminClient
      .schema("mts_sam")
      .rpc("get_published_content", {
        p_domain: domain,
      });

    if (contentRpcError) {
      console.error("[mts-content-read] get_published_content RPC failed:", contentRpcError.message);
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "INTERNAL_ERROR",
          error: "Failed to retrieve published content.",
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    if (!contentResult || !contentResult.ok) {
      const errorCode = contentResult?.error_code || "NO_PUBLICATION";
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: errorCode,
          error: contentResult?.error || "No published content available.",
        }),
        { status: 404, headers: corsHeaders }
      );
    }

    // 6. Return published content
    console.log(
      `[mts-content-read] Served ${domain} ${contentResult.version_id} ` +
      `(${contentResult.item_count} items) to installation ${installationId}`
    );

    return new Response(
      JSON.stringify({
        ok: true,
        domain: contentResult.domain,
        version_id: contentResult.version_id,
        content_hash: contentResult.content_hash,
        item_count: contentResult.item_count,
        published_at: contentResult.published_at,
        content: contentResult.content,
      }),
      { status: 200, headers: corsHeaders }
    );

  } catch (err) {
    console.error("[mts-content-read] Unhandled error:", err);
    return new Response(
      JSON.stringify({
        ok: false,
        error_code: "INTERNAL_ERROR",
        error: "An unexpected error occurred.",
      }),
      { status: 500, headers: corsHeaders }
    );
  }
});
