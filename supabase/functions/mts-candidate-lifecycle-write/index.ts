import { createClient } from "npm:@supabase/supabase-js@2";

interface RequestPayload {
  candidate?: {
    source_system?: string;
    source_candidate_id?: string;
    display_name?: string;
    first_name?: string;
    last_initial?: string;
    is_new?: boolean;
  };
  session?: {
    session_id?: string;
    candidate_name?: string;
    candidate_first_name?: string;
    candidate_last_initial?: string;
    tester_name?: string;
    session_type?: string;
    attempt_number?: number;
    current_attempt_number?: number;
    allowed_attempt_count?: number;
    extra_attempts_granted?: number;
    final_attempt?: boolean;
    raw_status?: string;
    calculated_result?: string;
    final_result?: string;
    withdrawn?: boolean;
    archived?: boolean;
    needs_sup_transfer?: boolean;
    pending_sup_transfer_id?: string;
    mock_calls_completed?: number;
    sup_transfers_completed?: number;
    call_results?: Record<string, unknown>;
    supervisor_transfer_results?: Record<string, unknown>;
    coaching_summary?: string;
    fail_summary?: string;
    review_notes?: string;
    evaluator_notes_summary?: string;
    skills?: Record<string, unknown>;
    final_notes?: Record<string, unknown>;
    headset_brand?: string;
    headset_model?: string;
    headset_usb?: boolean;
    noise_cancel?: boolean;
    environment_checks?: Record<string, unknown>;
    form_fill_status?: string;
    form_filled_at?: string;
    newbie_shift_number?: string;
    newbie_shift_data?: Record<string, unknown>;
    created_at?: string;
    completed_at?: string;
    source_payload?: Record<string, unknown>;
  };
  attempts?: Array<{
    source_action_id?: string;
    attempt_number?: number;
    attempt_type?: string;
    result?: string;
    occurred_at?: string;
    details?: Record<string, unknown>;
  }>;
  headset_review?: {
    review_id?: string;
    source_session_id?: string;
    brand?: string;
    model?: string;
    note?: string;
    status?: string;
  };
  newbie_shift_request?: {
    request_id?: string;
    source_session_id?: string;
    request_type?: string;
    request_status?: string;
    newbie_shift_number?: string;
    scheduled_at?: string;
    original_scheduled_at?: string;
    rescheduled_at?: string;
    timezone?: string;
    within_24_hours?: boolean;
    counts_as_attempt?: boolean;
    final_attempt?: boolean;
    current_attempt?: number;
    resulting_attempt?: number;
    becomes_final_attempt?: boolean;
    attempt_rule?: string;
    terminal_outcome?: string;
    requested_by?: string;
    request_reason?: string;
    request_details?: string;
    decision_by?: string;
    denial_reason?: string;
    created_at?: string;
    decision_at?: string;
  };
  // Explicitly reject any spoofed actor/caller parameters
  caller_auth_uid?: unknown;
  actor_user_id?: unknown;
  user_id?: unknown;
  role?: unknown;
  admin?: unknown;
  is_supervisor?: unknown;
}

const ALLOWED_FINAL_RESULTS = new Set([
  "Pass",
  "Fail",
  "Incomplete",
  "Withdrawn",
  "NC-NS",
  "Pending Sup Transfer",
  "Resumed-Pass",
  "Fail-Final Attempt",
]);

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token.trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
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

    // 1. Extract Bearer token from Authorization header
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!bearerToken) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized: Missing Authorization Bearer token." }),
        { status: 401, headers: corsHeaders }
      );
    }

    // Parse and validate request body
    let body: RequestPayload = {};
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid JSON request body." }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Reject any client-supplied spoofing fields
    if (
      body.caller_auth_uid !== undefined ||
      body.actor_user_id !== undefined ||
      body.user_id !== undefined ||
      body.role !== undefined ||
      body.admin !== undefined ||
      body.is_supervisor !== undefined
    ) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "UNKNOWN_AUTHORIZATION_FIELDS",
          error: "Request body must not supply caller identity or authorization override fields.",
        }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Validate DTO structure
    const candidate = body.candidate;
    const session = body.session;

    if (!candidate || !session) {
      return new Response(
        JSON.stringify({ ok: false, error: "Candidate and session payloads are required." }),
        { status: 400, headers: corsHeaders }
      );
    }

    const candidateName = String(candidate.display_name || session.candidate_name || "").trim();
    const sessionId = String(session.session_id || "").trim();
    const sourceCandId = String(candidate.source_candidate_id || "").trim();

    if (!candidateName || candidateName.length > 255) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid candidate name." }),
        { status: 400, headers: corsHeaders }
      );
    }

    if (!sessionId || sessionId.length > 255) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid session identity." }),
        { status: 400, headers: corsHeaders }
      );
    }

    if (!sourceCandId || sourceCandId.length > 255) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid candidate source identifier." }),
        { status: 400, headers: corsHeaders }
      );
    }

    const finalResult = String(session.final_result || "").trim();
    if (finalResult && !ALLOWED_FINAL_RESULTS.has(finalResult)) {
      return new Response(
        JSON.stringify({ ok: false, error: `Invalid final result: ${finalResult}` }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Connect to database using service-role client
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // 2. Authorize caller: MTS Installation Credential only
    const tokenHash = await hashToken(bearerToken);
    const { data: instVerifyResult, error: instRpcError } = await adminClient
      .schema("mts_sam")
      .rpc("verify_mts_installation_credential", {
        p_credential_hash: tokenHash,
      });

    if (instRpcError) {
      console.error("[mts-candidate-lifecycle-write] Installation verify RPC failed:", instRpcError.message);
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "INTERNAL_ERROR",
          error: "Failed to verify MTS installation credential.",
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    if (!instVerifyResult || !instVerifyResult.ok) {
      const errorCode = instVerifyResult?.error_code || "UNAUTHORIZED";
      const isRevokedOrInactive = errorCode === "INSTALLATION_REVOKED" || errorCode === "INSTALLATION_INACTIVE";
      const statusCode = isRevokedOrInactive ? 403 : 401;
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: errorCode,
          error: instVerifyResult?.error || "Unauthorized: Invalid or unrecognized MTS installation credential.",
        }),
        { status: statusCode, headers: corsHeaders }
      );
    }

    const installationId = instVerifyResult.installation_id;

    // 3. Invoke service-role-only transactional PostgreSQL RPC
    const { data: rpcResult, error: rpcError } = await adminClient
      .schema("mts_sam")
      .rpc("persist_candidate_lifecycle", {
        p_payload: {
          candidate: candidate,
          session: session,
          attempts: body.attempts || [],
          headset_review: body.headset_review || null,
          newbie_shift_request: body.newbie_shift_request || null,
        },
        p_actor_user_id: null,
        p_actor_installation_id: installationId,
      });

    if (rpcError) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "TRANSACTION_FAILED",
          error: "A database error occurred while persisting candidate lifecycle.",
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    if (!rpcResult?.ok) {
      const statusCode = rpcResult?.error_code?.startsWith("CONFLICTING_RETRY") ? 409 : 400;
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: rpcResult?.error_code || "HOSTED_WRITE_REJECTED",
          error: rpcResult?.error || "Transaction was rejected by authoritative policy.",
        }),
        { status: statusCode, headers: corsHeaders }
      );
    }

    return new Response(JSON.stringify(rpcResult), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: (error as Error).message || "Internal server error." }),
      { status: 500, headers: corsHeaders }
    );
  }
});
