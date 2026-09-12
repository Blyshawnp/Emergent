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
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ ok: false, error: "Hosted service configuration is missing." }),
        { status: 500, headers: corsHeaders }
      );
    }

    // 1. Extract Bearer token
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!jwt) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized: Missing Authorization Bearer token." }),
        { status: 401, headers: corsHeaders }
      );
    }

    // 2. Authenticate caller independently with Supabase Auth
    const callerClient = createClient(supabaseUrl, supabaseAnonKey || supabaseServiceKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });

    const { data: { user: authUser }, error: authError } = await callerClient.auth.getUser();

    if (authError || !authUser?.id) {
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized: Invalid or expired caller token." }),
        { status: 401, headers: corsHeaders }
      );
    }

    const authUid = authUser.id; // Supabase Auth UID (auth.users.id)

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

    // 3. Connect to database using service-role client for verification and execution
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // Query canonical app user by auth_user_id (authUid)
    const { data: appUserData, error: appUserError } = await adminClient
      .schema("mts_sam")
      .from("app_users")
      .select("id, auth_user_id, display_name, active")
      .eq("auth_user_id", authUid)
      .maybeSingle();

    if (appUserError || !appUserData) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "UNLINKED_ACCOUNT",
          error: "Your account is not registered for application access.",
        }),
        { status: 403, headers: corsHeaders }
      );
    }

    if (!appUserData.active) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "INACTIVE_ACCOUNT",
          error: "Your application account has been deactivated.",
        }),
        { status: 403, headers: corsHeaders }
      );
    }

    const canonicalAppUserId = appUserData.id; // Canonical mts_sam.app_users.id

    // 4. Verify active evaluator entitlement
    const { data: roleAssignments, error: roleError } = await adminClient
      .schema("mts_sam")
      .from("user_role_assignments")
      .select("id, role_key, revoked_at")
      .eq("user_id", canonicalAppUserId)
      .eq("role_key", "evaluator")
      .is("revoked_at", null);

    if (roleError || !roleAssignments || roleAssignments.length === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: "INSUFFICIENT_ROLE",
          error: "Your account does not have active evaluator permissions.",
        }),
        { status: 403, headers: corsHeaders }
      );
    }

    // 5. Invoke service-role-only transactional PostgreSQL RPC
    // Pass canonicalAppUserId as p_actor_user_id (referencing mts_sam.app_users.id)
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
        p_actor_user_id: canonicalAppUserId,
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
          error_code: rpcResult?.error_code || "PERSISTENCE_REJECTED",
          error: rpcResult?.error || "Candidate lifecycle update was rejected.",
        }),
        { status: statusCode, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        canonical_ids: rpcResult.canonical_ids,
        row_counts: rpcResult.row_counts,
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Internal server error";
    return new Response(
      JSON.stringify({ ok: false, error: "An unexpected error occurred." }),
      { status: 500, headers: corsHeaders }
    );
  }
});
